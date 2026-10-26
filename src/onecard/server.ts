/** Loopback resident runtime. Node's HTTP server only; the parent supervises the process. */
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import {
  AdapterError, ENGINE, MAX_REQUEST_BYTES, UPSTREAM_COMMIT, canonicalVault, handleRequest,
  openResidentStore, resolveGuardedFile, samePath, verifyEmbedModel, type StoreSession,
} from "./bridge.js";

type RuntimeConfig = {
  vaultPath: string;
  model: { path: string; sha256: string };
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

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  return present.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
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
  if (!exactKeys(record, ["schema_version", "upstream_commit", "command", "semantic"]))
    fail("invalid_config", "Runtime config shape is not valid.");
  if (record.schema_version !== 1) fail("invalid_config", "Runtime config schema is not supported.");
  if (record.upstream_commit !== UPSTREAM_COMMIT) fail("upstream_mismatch", "Runtime config does not match the pinned upstream commit.");
  if (typeof record.command !== "string" || record.command.length < 1 || record.command.length > 4096)
    fail("invalid_config", "Runtime config command is invalid.");
  const semantic = record.semantic;
  if (!semantic || typeof semantic !== "object" || Array.isArray(semantic)) fail("invalid_config", "Semantic config shape is not valid.");
  const semanticRecord = semantic as Record<string, unknown>;
  if (!exactKeys(semanticRecord, ["enabled", "vault_path", "embed_model", "resident"]) || semanticRecord.enabled !== true)
    fail("invalid_config", "Semantic config must be explicitly enabled.");
  const model = semanticRecord.embed_model;
  if (!model || typeof model !== "object" || Array.isArray(model)) fail("invalid_config", "Semantic config shape is not valid.");
  const modelRecord = model as Record<string, unknown>;
  if (!exactKeys(modelRecord, ["path", "sha256"]) || typeof modelRecord.path !== "string" || typeof modelRecord.sha256 !== "string")
    fail("invalid_config", "Semantic config shape is not valid.");
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
    vaultPath: semanticRecord.vault_path,
    model: { path: modelRecord.path, sha256: modelRecord.sha256 },
    tokenFile: residentRecord.token_file,
    url: residentRecord.url,
    port,
  };
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
  // `command` is retained by configuration validation and is never executed here.
  const pinned = await verifyEmbedModel(config.model);
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
    const model = await verifyEmbedModel(config.model);
    if (model.sha256 !== pinned.sha256 || !samePath(model.path, pinned.path))
      fail("model_mismatch", "The local embedding model does not match the pinned digest.");
    return {
      schema_version: 1,
      status: "ok",
      vault_path: canonicalVault(config.vaultPath),
      embed_model_sha256: model.sha256,
      engine: { ...ENGINE },
    };
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
    if (!statExists(dedicatedDb)) return handleRequest(value);
    let created = false;
    if (!store) {
      store = await openResidentStore(dedicatedDb, source, pinned.path);
      opened += 1;
      created = true;
    }
    return handleRequest(value, {
      store, modelPath: pinned.path, modelSha256: pinned.sha256, residency: created ? "cold" : "warm",
    });
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
