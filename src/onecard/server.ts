/** Loopback resident runtime. Node's HTTP server only; the parent supervises the process. */
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import {
  AdapterError, ENGINE, MAX_REQUEST_BYTES, UPSTREAM_COMMIT, canonicalVault, handleRequest,
  openResidentStore, resolveGuardedFile, samePath, verifyLocalModel, type StoreSession,
} from "./bridge.js";

type ModelPin = { path: string; sha256: string };
type DefaultMode = "lexical" | "vector" | "rrf" | "full";
type RuntimeConfig = {
  /** Parent argv, retained and never spawned. */
  command: readonly [string, string];
  /** Validated and ignored. Python selects the wire mode before the request. */
  defaultMode?: DefaultMode;
  vaultPath: string;
  model: ModelPin;
  quality?: { expansion: ModelPin; rerank: ModelPin };
  tokenFile: string;
  url: string;
  port: number;
};

export type Resident = {
  url: string;
  storesOpened: () => number;
  close: () => Promise<void>;
};

function fail(code: string, message: string): never { throw new AdapterError(code, message); }

const HASH = /^[0-9a-f]{64}$/;
const DEFAULT_MODES = new Set<DefaultMode>(["lexical", "vector", "rrf", "full"]);

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  return present.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
}

function allowedKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set<string>([...required, ...optional]);
  const present = Object.keys(record);
  return present.every(key => allowed.has(key)) && required.every(key => Object.prototype.hasOwnProperty.call(record, key));
}

function readConfigPin(value: unknown): ModelPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_config", "Model pin shape is not valid.");
  const pin = value as Record<string, unknown>;
  if (!exactKeys(pin, ["path", "sha256"]) || typeof pin.path !== "string" || typeof pin.sha256 !== "string" || !isAbsolute(pin.path) || !HASH.test(pin.sha256))
    fail("invalid_config", "Model pin shape is not valid.");
  return { path: pin.path, sha256: pin.sha256 };
}

function loadConfig(configPath: string): RuntimeConfig {
  const file = resolveGuardedFile(configPath, "invalid_config");
  if (statSync(file).size > 65_536) fail("invalid_config", "Runtime config exceeds the protocol budget.");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch { fail("invalid_config", "Runtime config is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid_config", "Runtime config must be one JSON object.");
  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "semantic"))
    fail("semantic_unconfigured", "Resident mode requires an enabled local semantic configuration.");
  if (!allowedKeys(record, ["schema_version", "upstream_commit", "command", "semantic"], ["default_mode"]))
    fail("invalid_config", "Runtime config shape is not valid.");
  if (record.schema_version !== 1) fail("invalid_config", "Runtime config schema is not supported.");
  if (record.upstream_commit !== UPSTREAM_COMMIT) fail("upstream_mismatch", "Runtime config does not match the pinned upstream commit.");
  let defaultMode: DefaultMode | undefined;
  if (Object.prototype.hasOwnProperty.call(record, "default_mode")) {
    if (typeof record.default_mode !== "string" || !DEFAULT_MODES.has(record.default_mode as DefaultMode))
      fail("invalid_config", "default_mode must be lexical, vector, rrf, or full.");
    defaultMode = record.default_mode as DefaultMode;
  }
  const command = loadCommand(record.command);
  const semantic = record.semantic;
  if (!semantic || typeof semantic !== "object" || Array.isArray(semantic)) fail("invalid_config", "Semantic config shape is not valid.");
  const semanticRecord = semantic as Record<string, unknown>;
  if (!allowedKeys(semanticRecord, ["enabled", "vault_path", "embed_model", "resident"], ["expansion_model", "rerank_model"]) || semanticRecord.enabled !== true)
    fail("invalid_config", "Semantic config must be explicitly enabled.");
  const hasExpansion = Object.prototype.hasOwnProperty.call(semanticRecord, "expansion_model");
  const hasRerank = Object.prototype.hasOwnProperty.call(semanticRecord, "rerank_model");
  if (hasExpansion !== hasRerank) fail("invalid_config", "Expansion and rerank models are pinned together.");
  const model = readConfigPin(semanticRecord.embed_model);
  const quality = hasExpansion && hasRerank
    ? { expansion: readConfigPin(semanticRecord.expansion_model), rerank: readConfigPin(semanticRecord.rerank_model) }
    : undefined;
  const resident = semanticRecord.resident;
  if (!resident || typeof resident !== "object" || Array.isArray(resident)) fail("invalid_config", "Resident config shape is not valid.");
  const residentRecord = resident as Record<string, unknown>;
  if (!exactKeys(residentRecord, ["url", "token_file"]) || typeof residentRecord.url !== "string" || typeof residentRecord.token_file !== "string")
    fail("invalid_config", "Resident config shape is not valid.");
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(residentRecord.url);
  const port = match ? Number(match[1]) : 0;
  if (!match || port > 65_535) fail("invalid_config", "Resident URL must be http://127.0.0.1:PORT.");
  if (typeof semanticRecord.vault_path !== "string") fail("invalid_config", "Semantic config shape is not valid.");
  return {
    command,
    defaultMode,
    vaultPath: semanticRecord.vault_path,
    model,
    quality,
    tokenFile: residentRecord.token_file,
    url: residentRecord.url,
    port,
  };
}

function loadCommand(value: unknown): [string, string] {
  if (!Array.isArray(value) || value.length !== 2)
    fail("invalid_config", "Runtime config command must be two absolute files.");
  const retained: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isAbsolute(item))
      fail("invalid_config", "Runtime config command must be two absolute files.");
    resolveGuardedFile(item, "invalid_config");
    retained.push(item);
  }
  const executable = retained[0];
  const entry = retained[1];
  if (!executable || !entry) fail("invalid_config", "Runtime config command must be two absolute files.");
  return [executable, entry];
}

function readToken(tokenFile: string): string {
  const file = resolveGuardedFile(tokenFile, "token_unreadable");
  if (statSync(file).size > 4096) fail("token_unreadable", "The resident token file is not usable.");
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch { fail("token_unreadable", "The resident token file is not usable."); }
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.length === 0 || text.includes("\n") || text.includes("\r")) fail("token_unreadable", "The resident token file is not usable.");
  return text;
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(header: string | string[] | undefined, token: string): void {
  if (typeof header !== "string" || !/^Bearer /i.test(header)) fail("unauthorized", "Authorization is required.");
  const presented = header.slice(header.indexOf(" ") + 1);
  if (!tokensEqual(presented, token)) fail("unauthorized", "Authorization is required.");
}

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AdapterError) return { code: error.code, message: error.message };
  return { code: "qmd_operation_failed", message: "QMD operation failed; local files were preserved." };
}

function statusOf(error: unknown): number {
  const code = error instanceof AdapterError ? error.code : "qmd_operation_failed";
  if (code === "unauthorized") return 401;
  if (code === "origin_rejected" || code === "peer_rejected") return 403;
  if (code === "not_found" || code === "source_missing") return 404;
  if (code === "method_not_allowed" || code === "action_unavailable") return 405;
  if (code === "request_too_large") return 413;
  if (code === "server_unavailable") return 503;
  if (code === "qmd_operation_failed" || code === "embed_failed") return 500;
  return 400;
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function assertPeer(req: IncomingMessage): void {
  const address = req.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") fail("peer_rejected", "Only loopback clients are accepted.");
}

function readBody(req: IncomingMessage): Promise<string> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && Number(declared) > MAX_REQUEST_BYTES)
    fail("request_too_large", "Request exceeds the protocol budget.");
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolveBody(value ?? "");
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        finish(new AdapterError("request_too_large", "Request exceeds the protocol budget."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", error => finish(error));
    req.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf8")));
  });
}

export async function startResident(configPath: string): Promise<Resident> {
  const config = loadConfig(configPath);
  // Parent setup owns this argv. The array is retained and never passed to a process.
  // defaultMode is validated above and is not applied to wire mode "auto".
  void config.defaultMode;
  const pinned = await verifyLocalModel(config.model, "embedding");
  const quality = config.quality
    ? {
        expansion: await verifyLocalModel(config.quality.expansion, "expansion"),
        rerank: await verifyLocalModel(config.quality.rerank, "rerank"),
      }
    : undefined;
  const vault = canonicalVault(config.vaultPath);
  readToken(config.tokenFile);
  const source = join(vault, "AgentNotes", "Atoms");
  const dedicatedDb = join(vault, ".knowledge", "qmd", "index.sqlite");
  let store: StoreSession["store"] | undefined;
  let opened = 0;
  let chain: Promise<void> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const health = async (): Promise<Record<string, unknown>> => {
    const model = await verifyLocalModel(config.model, "embedding");
    if (model.sha256 !== pinned.sha256 || !samePath(model.path, pinned.path))
      fail("model_mismatch", "The local embedding model does not match the pinned digest.");
    const body: Record<string, unknown> = {
      schema_version: 1,
      status: "ok",
      vault_path: canonicalVault(config.vaultPath),
      embed_model_sha256: model.sha256,
      engine: { ...ENGINE },
    };
    if (quality && config.quality) {
      const expansion = await verifyLocalModel(config.quality.expansion, "expansion");
      const rerank = await verifyLocalModel(config.quality.rerank, "rerank");
      if (expansion.sha256 !== quality.expansion.sha256 || !samePath(expansion.path, quality.expansion.path)
          || rerank.sha256 !== quality.rerank.sha256 || !samePath(rerank.path, quality.rerank.path))
        fail("model_mismatch", "The local quality model does not match the pinned digest.");
      body.quality_models = {
        expansion_model_sha256: expansion.sha256,
        rerank_model_sha256: rerank.sha256,
      };
    }
    return body;
  };

  const serveRpc = (value: unknown): Promise<Record<string, unknown>> => exclusive(async () => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request", "Expected one JSON object.");
    const record = value as Record<string, unknown>;
    if (record.action === "index" || record.action === "embed")
      fail("action_unavailable", "Index and embed remain explicit stdin actions.");
    if (record.action !== "search" && record.action !== "status") return handleRequest(value);
    const requestVault = canonicalVault(record.vault_path);
    if (!samePath(requestVault, vault)) fail("vault_mismatch", "The request vault does not match the resident configuration.");
    if (typeof record.db_path !== "string" || !isAbsolute(record.db_path) || !samePath(resolve(record.db_path), dedicatedDb))
      fail("invalid_db", "Use the dedicated vault QMD index.");
    const session = (residency: "cold" | "warm", openedStore?: StoreSession["store"]): StoreSession => ({
      store: openedStore,
      modelPath: pinned.path,
      modelSha256: pinned.sha256,
      residency,
      ...(quality ? {
        expansionPath: quality.expansion.path,
        expansionSha256: quality.expansion.sha256,
        rerankPath: quality.rerank.path,
        rerankSha256: quality.rerank.sha256,
      } : {}),
    });
    if (!statExists(dedicatedDb)) return handleRequest(value, session("cold"));
    let created = false;
    if (!store) {
      store = await openResidentStore(dedicatedDb, source, pinned.path, quality
        ? { expansionPath: quality.expansion.path, rerankPath: quality.rerank.path }
        : undefined);
      opened += 1;
      created = true;
    }
    return handleRequest(value, session(created ? "cold" : "warm", store));
  });

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    assertPeer(req);
    if (req.headers.origin !== undefined) fail("origin_rejected", "Origin headers are not accepted.");
    const url = new URL(req.url ?? "/", config.url);
    if (url.pathname !== "/health" && url.pathname !== "/rpc") fail("not_found", "The resident path is not available.");
    if (url.search) fail("not_found", "The resident path is not available.");
    if (url.pathname === "/health" && req.method !== "GET") fail("method_not_allowed", "Health accepts GET.");
    if (url.pathname === "/rpc" && req.method !== "POST") fail("method_not_allowed", "RPC accepts POST.");
    authorize(req.headers.authorization, readToken(config.tokenFile));
    if (url.pathname === "/health") {
      send(res, 200, await health());
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { fail("invalid_request", "Expected one JSON object."); }
    send(res, 200, await serveRpc(parsed));
  };

  const server = createServer((req, res) => {
    void onRequest(req, res).catch(error => {
      if (res.writableEnded || res.headersSent) return;
      send(res, statusOf(error), { schema_version: 1, error: publicError(error) });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListen);
      reject(new AdapterError(error.code === "EADDRINUSE" ? "address_in_use" : "server_unavailable",
        error.code === "EADDRINUSE" ? "The resident port is already in use." : "The resident server could not bind 127.0.0.1."));
    };
    const onListen = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port !== config.port) {
        reject(new AdapterError("server_unavailable", "The resident server did not bind 127.0.0.1 at the configured port."));
        return;
      }
      resolveListen();
    };
    server.once("error", onError);
    server.listen(config.port, "127.0.0.1", onListen);
  });

  return {
    url: config.url,
    storesOpened: () => opened,
    close: async () => {
      await exclusive(async () => {
        if (!store) return;
        const current = store;
        store = undefined;
        await current.close();
      });
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}

function statExists(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

export async function callResident(endpoint: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(endpoint);
  const port = match ? Number(match[1]) : 0;
  if (!match || port > 65_535) fail("invalid_request", "Resident calls must use the loopback RPC endpoint.");
  let response: Response;
  try {
    response = await fetch(endpoint + "/rpc", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("server_unavailable", "The resident server is not accepting local connections.");
  }
  if (response.status >= 300 && response.status < 400)
    throw new AdapterError("server_unavailable", "The resident server is not accepting local connections.");
  let parsed: unknown;
  try { parsed = JSON.parse(await response.text()); }
  catch { throw new AdapterError("qmd_operation_failed", "QMD operation failed; local files were preserved."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AdapterError("qmd_operation_failed", "QMD operation failed; local files were preserved.");
  const record = parsed as Record<string, unknown>;
  const failure = record.error;
  if (failure && typeof failure === "object" && !Array.isArray(failure) && typeof (failure as { code?: unknown }).code === "string") {
    const description = (failure as { message?: unknown }).message;
    throw new AdapterError((failure as { code: string }).code, typeof description === "string" ? description : "Request failed.");
  }
  if (!response.ok) throw new AdapterError("qmd_operation_failed", "QMD operation failed; local files were preserved.");
  return record;
}
