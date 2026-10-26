import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync, symlinkSync, lstatSync, statSync, existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLLECTION, UPSTREAM_COMMIT, handleRequest, openResidentStore, type StoreSession } from "../src/onecard/bridge.js";
import { callResident, startResident, type Resident } from "../src/onecard/server.js";
import type { QMDStore, SearchResult } from "../src/index.js";

let vault: string, db: string, source: string;
const residents: Resident[] = [];
const children: ChildProcess[] = [];
const one = "11111111-1111-4111-8111-111111111111";
const two = "22222222-2222-4222-8222-222222222222";
const card = "a".repeat(64), version = "b".repeat(64);
const token = "synthetic-resident-token";

function note(id: string, body: string, review?: string): void {
  const reviewField = review ? `, review_status: "${review}"` : "";
  writeFileSync(join(source, id + ".md"),
    `---\nqmd: {metadata: {permalink: "knowledge/${id}", card_version: "${card}", source_version: "${version}"${reviewField}}}\n---\n\n# ${body}\n\n${body}\n`);
}
function request(action: string, extra = {}) {
  return handleRequest({ schema_version: 1, action, vault_path: vault, db_path: db, ...extra });
}
function modelFile(name: string, bytes: string) {
  const path = join(vault, name);
  writeFileSync(path, bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function semantic(model: { path: string; sha256: string }) {
  return { embed_model: model };
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
function writeToken(path = join(vault, "resident.token")): string {
  writeFileSync(path, token + "\n", { mode: 0o600 });
  return path;
}
function contractCommand(): [string, string] {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return [process.execPath, join(root, "dist", "onecard", "cli.js")];
}
function writeConfig(port: number, tokenFile: string, model: { path: string; sha256: string }, command: readonly string[] = contractCommand()) {
  const path = join(vault, `runtime-${port}.json`);
  writeFileSync(path, JSON.stringify({
    schema_version: 1, upstream_commit: UPSTREAM_COMMIT, command,
    semantic: { enabled: true, vault_path: vault, embed_model: model,
      resident: { url: `http://127.0.0.1:${port}`, token_file: tokenFile } },
  }));
  return path;
}
async function boot(model: { path: string; sha256: string }, command?: readonly string[]): Promise<{ resident: Resident; port: number }> {
  const port = await freePort();
  const resident = await startResident(writeConfig(port, writeToken(), model, command));
  residents.push(resident);
  return { resident, port };
}
function rpc(port: number, extra = {}) {
  return callResident(`http://127.0.0.1:${port}`, token,
    { schema_version: 1, action: "search", vault_path: vault, db_path: db, query: "padding margin", limit: 2, ...extra });
}
function idsOf(body: Record<string, unknown>) {
  return (body.results as { docid: string; score: number }[]).map(hit => [hit.docid, hit.score]);
}

const SYMLINK_UNAVAILABLE = new Set(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** Probe once. File links cannot fall back to a junction; a directory junction counts only when lstat still reports a symlink. */
function symlinkAvailable(kind: "file" | "dir" | "junction"): boolean {
  if (kind === "junction" && process.platform !== "win32") return false;
  const root = mkdtempSync(join(tmpdir(), "onecard-symlink-cap-"));
  try {
    const target = join(root, "target");
    const link = join(root, "link");
    if (kind === "file") writeFileSync(target, "probe");
    else mkdirSync(target);
    try { symlinkSync(target, link, kind); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && SYMLINK_UNAVAILABLE.has(code)) return false;
      throw error;
    }
    return kind !== "junction" || lstatSync(link).isSymbolicLink();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const fileSymlinks = symlinkAvailable("file");
const vaultLinkKind = symlinkAvailable("dir") ? "dir" as const : symlinkAvailable("junction") ? "junction" as const : undefined;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "onecard-semantic-"));
  source = join(vault, "AgentNotes", "Atoms");
  mkdirSync(source, { recursive: true });
  db = join(vault, ".knowledge", "qmd", "index.sqlite");
  note(one, "padding margin crowded layout");
  note(two, "padding margin layout examples", "unreviewed");
});
afterEach(async () => {
  if (!vault.startsWith(join(tmpdir(), "onecard-semantic-"))) throw new Error("Unexpected test root");
  for (const child of children) child.kill("SIGKILL");
  children.length = 0;
  for (const resident of residents) await resident.close().catch(() => undefined);
  residents.length = 0;
  await Bun.sleep(20);
  Bun.gc(true);
  try { rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
  catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
});

describe("One Card semantic contract", () => {
  test("auto stays lexical and hybrid is rejected", async () => {
    await request("index");
    const auto = await request("search", { query: "padding margin", limit: 2, mode: "auto" });
    const lexical = await request("search", { query: "padding margin", limit: 2 });
    expect((auto.engine as { mode: string; adapter_revision: string; remote_model_calls: number }).mode).toBe("lexical");
    expect((auto.engine as { adapter_revision: string }).adapter_revision).toBe("onecard-qmd-v2");
    expect((lexical.engine as { remote_model_calls: number }).remote_model_calls).toBe(0);
    expect(idsOf(auto)).toEqual(idsOf(lexical));
    expect(auto.residency).toBe("cold");
    await expect(request("search", { query: "padding", mode: "hybrid" })).rejects.toMatchObject({ code: "mode_unavailable" });
    await expect(request("search", { query: "padding", mode: "vector" })).rejects.toMatchObject({ code: "semantic_unconfigured" });
    await expect(request("search", { query: "padding", semantic: { embed_model: { path: vault, sha256: card } } })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(request("search", { query: "padding", intent: "spacing" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("missing model, digest, gguf header, index, and embeddings are explicit", async () => {
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const missing = join(vault, "missing.gguf");
    await expect(request("search", { query: "padding", mode: "vector", semantic: semantic({ path: missing, sha256: card }) }))
      .rejects.toMatchObject({ code: "model_missing" });
    await expect(request("search", { query: "padding", mode: "vector", semantic: semantic({ ...model, sha256: "c".repeat(64) }) }))
      .rejects.toMatchObject({ code: "model_mismatch" });
    const fake = modelFile("notes.gguf", "this is not a model");
    await expect(request("search", { query: "padding", mode: "rrf", semantic: semantic(fake) })).rejects.toMatchObject({ code: "model_invalid" });
    expect(readFileSync(fake.path, "utf8")).toBe("this is not a model");
    await expect(request("search", { query: "padding", mode: "vector", semantic: semantic(model) })).rejects.toMatchObject({ code: "index_missing" });
    await request("index");
    const lexical = await request("search", { query: "padding", limit: 2 });
    expect((lexical.results as unknown[]).length).toBeGreaterThan(0);
    await expect(request("search", { query: "padding", mode: "vector", semantic: semantic(model) })).rejects.toMatchObject({ code: "embeddings_missing" });
    await expect(request("search", { query: "padding", mode: "rrf", allowed_ids: [], semantic: semantic(model) })).rejects.toMatchObject({ code: "embeddings_missing" });
    expect(idsOf(await request("search", { query: "padding", limit: 2 }))).toEqual(idsOf(lexical));
  });

  test("archived models, foreign vaults, and current document ids are refused", async () => {
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const boxed = join(vault, "boxed");
    mkdirSync(boxed);
    writeFileSync(join(boxed, "ARCHIVED.json"), "{}");
    const archived = modelFile("boxed/model.gguf", "GGUF-archived");
    await expect(request("search", { query: "padding", mode: "vector", semantic: semantic(archived) })).rejects.toMatchObject({ code: "archived" });
    const other = mkdtempSync(join(tmpdir(), "onecard-other-vault-"));
    try {
      mkdirSync(join(other, "AgentNotes", "Atoms"), { recursive: true });
      await expect(handleRequest({ schema_version: 1, action: "search", vault_path: other, db_path: db, query: "padding" }))
        .rejects.toMatchObject({ code: "invalid_db" });
    } finally {
      if (!other.startsWith(join(tmpdir(), "onecard-other-vault-"))) throw new Error("Unexpected test vault");
      rmSync(other, { recursive: true, force: true });
    }
    await expect(request("search", { query: "padding", mode: "vector", allowed_ids: ["../other"], semantic: semantic(model) }))
      .rejects.toMatchObject({ code: "invalid_ids" });
  });

  test.skipIf(!fileSymlinks)("a model file symlink is refused", async () => {
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const link = join(vault, "model-link.gguf");
    symlinkSync(model.path, link, "file");
    await expect(request("search", { query: "padding", mode: "vector", semantic: semantic({ path: link, sha256: model.sha256 }) }))
      .rejects.toMatchObject({ code: "path_escape" });
  });

  test.skipIf(vaultLinkKind === undefined)("a vault directory link is refused", async () => {
    if (!vaultLinkKind) throw new Error("Directory link capability is unavailable.");
    const vaultLink = join(tmpdir(), "onecard-vault-link-" + vault.slice(-6));
    symlinkSync(vault, vaultLink, vaultLinkKind);
    try {
      await expect(handleRequest({ schema_version: 1, action: "search", vault_path: vaultLink, db_path: db, query: "padding" }))
        .rejects.toMatchObject({ code: "path_escape" });
    } finally {
      if (!lstatSync(vaultLink).isSymbolicLink()) throw new Error("Vault link fixture is not a symlink.");
      if (process.platform === "win32" && vaultLinkKind === "junction") rmdirSync(vaultLink);
      else rmSync(vaultLink, { force: true });
    }
  });

  test.skipIf(!fileSymlinks)("a token file symlink is refused", async () => {
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const tokenLink = join(vault, "token-link");
    writeToken();
    symlinkSync(join(vault, "resident.token"), tokenLink, "file");
    await expect(startResident(writeConfig(9, tokenLink, model))).rejects.toMatchObject({ code: "path_escape" });
  });

  test("vector and rrf call the SDK directly and keep source identity", async () => {
    await request("index");
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const verified = realpathSync(model.path);
    const real = await openResidentStore(db, source, verified);
    const calls: string[] = [];
    let vectorArgs: { query?: string; options?: { collection?: string; limit?: number; filter?: unknown } } = {};
    let rrfArgs: { queries?: { type: string; query: string }[]; rerank?: boolean; intent?: string } = {};
    const lex = await real.searchLex("padding margin", { collection: COLLECTION, limit: 2 });
    const hit = lex.find(item => item.displayPath.endsWith(two + ".md"));
    if (!hit) throw new Error("Missing synthetic hit");
    writeFileSync(join(source, two + ".md"), readFileSync(join(source, two + ".md"), "utf8").replace(card, "c".repeat(64)));
    const session = (store: QMDStore): StoreSession => ({ store, modelPath: verified, modelSha256: model.sha256, residency: "warm" });
    try {
      const vectorStore: QMDStore = {
        ...real,
        close: async () => { calls.push("close"); },
        getStatus: async () => ({ totalDocuments: 2, needsEmbedding: 0, hasVectorIndex: true, pendingMetadata: 0, collections: [] }),
        searchVector: async (query, options) => { calls.push("searchVector"); vectorArgs = { query, options }; return [hit as SearchResult]; },
        searchLex: async () => { calls.push("searchLex"); throw new Error("lexical fallback"); },
        search: async () => { calls.push("search"); throw new Error("rrf fallback"); },
        embed: async () => { calls.push("embed"); throw new Error("embed"); },
        update: async () => { calls.push("update"); throw new Error("update"); },
        expandQuery: async () => { calls.push("expandQuery"); throw new Error("expand"); },
      };
      const vector = await handleRequest({
        schema_version: 1, action: "search", mode: "vector", vault_path: vault, db_path: db,
        query: "padding margin", limit: 2, allowed_ids: [two], semantic: semantic(model),
      }, session(vectorStore));
      const row = (vector.results as { id: string; score: number; sha256: string; indexed_card_version: string; indexed_source_version: string; indexed_review_status?: string }[])[0];
      const changed = readFileSync(join(source, two + ".md"), "utf8").replace(/\r\n/g, "\n");
      expect(row?.id).toBe(two);
      expect(row?.score).toBe(hit.score);
      expect(row?.indexed_card_version).toBe(card);
      expect(row?.indexed_source_version).toBe(version);
      expect(row?.indexed_review_status).toBe("unreviewed");
      expect(row?.sha256).toBe(createHash("sha256").update(changed).digest("hex"));
      expect(vectorArgs.query).toBe("padding margin");
      expect(vectorArgs.options).toMatchObject({ collection: COLLECTION, limit: 2, filter: { field: "permalink", operator: "in", value: [`knowledge/${two}`] } });
      expect(calls).toContain("searchVector");
      expect(calls).not.toContain("searchLex");
      expect(calls).not.toContain("embed");
      expect(calls).not.toContain("update");
      expect(calls).not.toContain("expandQuery");
      expect(calls).not.toContain("close");

      const rrfStore: QMDStore = {
        ...real,
        close: async () => { calls.push("close"); },
        getStatus: async () => ({ totalDocuments: 2, needsEmbedding: 0, hasVectorIndex: true, pendingMetadata: 0, collections: [] }),
        search: async options => {
          calls.push("search");
          rrfArgs = options;
          return [{ file: hit.filepath, displayPath: hit.displayPath, title: hit.title, body: hit.body ?? "",
            bestChunk: "", bestChunkPos: 0, score: 0.42, context: null, docid: hit.docid, metadata: hit.metadata }];
        },
        searchLex: async () => { calls.push("searchLex"); throw new Error("lexical fallback"); },
        searchVector: async () => { calls.push("searchVector"); throw new Error("vector fallback"); },
        embed: async () => { calls.push("embed"); throw new Error("embed"); },
        update: async () => { calls.push("update"); throw new Error("update"); },
        expandQuery: async () => { calls.push("expandQuery"); throw new Error("expand"); },
      };
      calls.length = 0;
      const fused = await handleRequest({
        schema_version: 1, action: "search", mode: "rrf", vault_path: vault, db_path: db,
        query: "padding margin", limit: 2, semantic: semantic(model),
      }, session(rrfStore));
      expect((fused.results as { score: number; indexed_hash: string }[])[0]?.score).toBe(0.42);
      expect((fused.results as { indexed_hash: string }[])[0]?.indexed_hash).toBe(hit.hash);
      expect(rrfArgs).toEqual({
        queries: [{ type: "lex", query: "padding margin" }, { type: "vec", query: "padding margin" }],
        rerank: false, collection: COLLECTION, filter: undefined, limit: 2,
      });
      expect(rrfArgs.intent).toBeUndefined();
      expect(calls).toContain("search");
      expect(calls).not.toContain("searchLex");
      expect(calls).not.toContain("searchVector");
      expect(calls).not.toContain("embed");
      expect(calls).not.toContain("expandQuery");
      expect(calls).not.toContain("close");
    } finally { await real.close(); }
  });

  test("embed calls the native store with the verified local model and does not search", async () => {
    await request("index");
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const verified = realpathSync(model.path);
    const real = await openResidentStore(db, source, verified);
    const calls: string[] = [];
    let options: unknown;
    const wrapped: QMDStore = {
      ...real,
      close: async () => { calls.push("close"); },
      embed: async embedOptions => {
        calls.push("embed");
        options = embedOptions;
        return { docsProcessed: 1, chunksEmbedded: 2, chunksCopied: 0, errors: 0, durationMs: 4 };
      },
      searchLex: async () => { calls.push("searchLex"); throw new Error("search"); },
      searchVector: async () => { calls.push("searchVector"); throw new Error("search"); },
      update: async () => { calls.push("update"); throw new Error("update"); },
    };
    try {
      const response = await handleRequest({
        schema_version: 1, action: "embed", vault_path: vault, db_path: db, semantic: semantic(model),
      }, { store: wrapped, modelPath: verified, modelSha256: model.sha256, residency: "cold" });
      expect(options).toEqual({ model: verified, collection: COLLECTION });
      expect((response.embed as { docsProcessed: number; errors: number }).docsProcessed).toBe(1);
      expect((response.embed as { errors: number }).errors).toBe(0);
      expect((response.engine as { mode: string; remote_model_calls: number }).mode).toBe("vector");
      expect((response.engine as { remote_model_calls: number }).remote_model_calls).toBe(0);
      expect(calls).toContain("embed");
      expect(calls).not.toContain("searchLex");
      expect(calls).not.toContain("searchVector");
      expect(calls).not.toContain("update");
      expect(calls).not.toContain("close");
    } finally { await real.close(); }
  });

  test("resident auth, origin, vault, health, and warm store reuse", async () => {
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    await request("index");
    writeToken();
    const mode = statSync(join(vault, "resident.token")).mode;
    const { resident, port } = await boot(model);
    expect(statSync(join(vault, "resident.token")).mode).toBe(mode);
    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } });
    const health = await healthResponse.json() as Record<string, unknown>;
    expect(healthResponse.status).toBe(200);
    expect(health).toEqual({
      schema_version: 1,
      status: "ok",
      vault_path: realpathSync(vault),
      embed_model_sha256: model.sha256,
      engine: {
        name: "qmd", version: "2.8.3", upstream_commit: UPSTREAM_COMMIT,
        adapter_revision: "onecard-qmd-v2", mode: "lexical", remote_model_calls: 0,
      },
    });
    expect(resident.storesOpened()).toBe(0);
    const denied = await fetch(`http://127.0.0.1:${port}/health`);
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain(token);
    const wrong = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST", headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ schema_version: 1, action: "search" }),
    });
    expect(wrong.status).toBe(401);
    const origin = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ schema_version: 1, action: "search", query: "padding margin", vault_path: vault, db_path: db }),
    });
    const originBody = await origin.text();
    expect(origin.status).toBe(403);
    expect(JSON.parse(originBody).error.code).toBe("origin_rejected");
    expect(originBody).not.toContain("padding");
    expect(originBody).not.toContain(token);
    const missingPath = await fetch(`http://127.0.0.1:${port}/search`, { headers: { authorization: `Bearer ${token}` } });
    expect(missingPath.status).toBe(404);
    const invalid = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{",
    });
    expect((await invalid.json() as { error: { code: string } }).error.code).toBe("invalid_request");
    const oversized = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: Buffer.alloc(1024 * 1024 + 1, 0x61),
    });
    expect((await oversized.json() as { error: { code: string } }).error.code).toBe("request_too_large");
    const direct = await request("search", { query: "padding margin", limit: 2 });
    const cold = await rpc(port);
    const warm = await rpc(port);
    expect(idsOf(cold)).toEqual(idsOf(direct));
    expect(idsOf(warm)).toEqual(idsOf(direct));
    expect(cold.residency).toBe("cold");
    expect(warm.residency).toBe("warm");
    expect(typeof cold.latency_ms).toBe("number");
    expect(typeof warm.latency_ms).toBe("number");
    expect(resident.storesOpened()).toBe(1);
    expect((cold.engine as { mode: string; remote_model_calls: number }).mode).toBe("lexical");
    expect((cold.engine as { remote_model_calls: number }).remote_model_calls).toBe(0);
    await Promise.all(Array.from({ length: 4 }, () => rpc(port, { query: "padding" })));
    expect(resident.storesOpened()).toBe(1);
    await expect(rpc(port, { mode: "vector", semantic: semantic(model) })).rejects.toMatchObject({ code: "embeddings_missing" });
    await expect(rpc(port, { mode: "rrf", semantic: semantic(model) })).rejects.toMatchObject({ code: "embeddings_missing" });
    expect(resident.storesOpened()).toBe(1);
    const other = mkdtempSync(join(tmpdir(), "onecard-other-vault-"));
    try {
      await expect(rpc(port, { vault_path: other, db_path: join(other, ".knowledge", "qmd", "index.sqlite") }))
        .rejects.toMatchObject({ code: "vault_mismatch" });
    } finally { rmSync(other, { recursive: true, force: true }); }
    await expect(rpc(port, { action: "index" })).rejects.toMatchObject({ code: "action_unavailable" });
    await expect(rpc(port, { action: "embed", semantic: semantic(model), query: undefined, limit: undefined }))
      .rejects.toMatchObject({ code: "action_unavailable" });
    expect(resident.storesOpened()).toBe(1);
    writeFileSync(join(vault, "ARCHIVED.json"), "{}");
    await expect(rpc(port)).rejects.toMatchObject({ code: "archived" });
  });

  test("a closed port is an explicit server error and does not index locally", async () => {
    const port = await freePort();
    await expect(callResident(`http://127.0.0.1:${port}`, token, {
      schema_version: 1, action: "search", vault_path: vault, db_path: db, query: "padding",
    })).rejects.toMatchObject({ code: "server_unavailable" });
    expect(existsSync(db)).toBe(false);
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const config = writeConfig(port, writeToken(), model);
    const rewritten = JSON.parse(readFileSync(config, "utf8")) as { upstream_commit: string; semantic: { resident: { url: string } } };
    rewritten.upstream_commit = "0".repeat(40);
    writeFileSync(config, JSON.stringify(rewritten));
    await expect(startResident(config)).rejects.toMatchObject({ code: "upstream_mismatch" });
    rewritten.upstream_commit = UPSTREAM_COMMIT;
    rewritten.semantic.resident.url = "http://localhost:" + port;
    writeFileSync(config, JSON.stringify(rewritten));
    await expect(startResident(config)).rejects.toMatchObject({ code: "invalid_config" });
  });

  test("the parent command argv is two guarded files and health stays uninferred", async () => {
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const port = await freePort();
    const tokenFile = writeToken();
    const command = contractCommand();
    const config = {
      schema_version: 1,
      upstream_commit: UPSTREAM_COMMIT,
      command,
      semantic: {
        enabled: true,
        vault_path: vault,
        embed_model: { path: model.path, sha256: model.sha256 },
        resident: { url: `http://127.0.0.1:${port}`, token_file: tokenFile },
      },
    };
    const path = join(vault, "runtime.json");
    writeFileSync(path, JSON.stringify(config));
    const resident = await startResident(path);
    residents.push(resident);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema_version: 1,
      status: "ok",
      vault_path: realpathSync(vault),
      embed_model_sha256: model.sha256,
      engine: {
        name: "qmd", version: "2.8.3", upstream_commit: UPSTREAM_COMMIT,
        adapter_revision: "onecard-qmd-v2", mode: "lexical", remote_model_calls: 0,
      },
    });
    expect(JSON.parse(readFileSync(path, "utf8")).command).toEqual(command);
    const malformed = join(vault, "malformed-command.json");
    for (const bad of [
      "onecard-qmd",
      [command[0]],
      [command[0], command[1], command[0]],
      [command[0], "dist/onecard/cli.js"],
      [command[0], join(vault, "missing-cli.js")],
      { executable: command[0], entry: command[1] },
    ]) {
      writeFileSync(malformed, JSON.stringify({ ...config, command: bad }));
      await expect(startResident(malformed)).rejects.toMatchObject({ code: "invalid_config" });
    }
  });

  test("the serve command binds the configured loopback port without logging content", async () => {
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const port = await freePort();
    const config = writeConfig(port, writeToken(), model);
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const child = spawn(process.execPath, [join(root, "src/onecard/cli.ts"), "--serve", "--config", config],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.stderr?.on("data", chunk => { output += String(chunk); });
    const started = Date.now();
    let health: Record<string, unknown> | undefined;
    while (Date.now() - started < 5000) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } });
        if (response.ok) { health = await response.json() as Record<string, unknown>; break; }
      } catch { /* the process is still binding */ }
      await Bun.sleep(50);
    }
    expect(health?.status).toBe("ok");
    expect(health?.vault_path).toBe(realpathSync(vault));
    expect(health?.embed_model_sha256).toBe(model.sha256);
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      Bun.sleep(3000).then(() => child.kill("SIGKILL")),
    ]);
    expect(output).not.toContain(token);
    expect(output).not.toContain("padding margin");
  });
});
