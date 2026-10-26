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
function writeConfig(
  port: number,
  tokenFile: string,
  model: { path: string; sha256: string },
  command: readonly string[] = contractCommand(),
  extra: { defaultMode?: string; expansion?: { path: string; sha256: string }; rerank?: { path: string; sha256: string }; unknown?: boolean } = {},
) {
  const path = join(vault, `runtime-${port}.json`);
  const semantic: Record<string, unknown> = {
    enabled: true, vault_path: vault, embed_model: model,
    resident: { url: `http://127.0.0.1:${port}`, token_file: tokenFile },
  };
  if (extra.expansion) semantic.expansion_model = extra.expansion;
  if (extra.rerank) semantic.rerank_model = extra.rerank;
  if (extra.unknown) semantic.extra = true;
  const body: Record<string, unknown> = { schema_version: 1, upstream_commit: UPSTREAM_COMMIT, command, semantic };
  if (extra.defaultMode !== undefined) body.default_mode = extra.defaultMode;
  writeFileSync(path, JSON.stringify(body));
  return path;
}
function fullSemantic(embed: { path: string; sha256: string }, expansion: { path: string; sha256: string }, rerank: { path: string; sha256: string }) {
  return { embed_model: embed, expansion_model: expansion, rerank_model: rerank };
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
    let vectorArgs: { query?: string; options?: { collection?: string | string[]; limit?: number; filter?: unknown } } = {};
    let rrfArgs: { queries?: { type: string; query: string }[]; rerank?: boolean; intent?: string; collection?: string; filter?: unknown; limit?: number } = {};
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

  test("full calls upstream search with the query and rerank enabled", async () => {
    await request("index");
    const lexicalIds = idsOf(await request("search", { query: "padding margin", limit: 2 }));
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const expansion = modelFile("expand.gguf", "GGUF-expansion");
    const rerank = modelFile("rerank.gguf", "GGUF-rerank");
    const verified = realpathSync(model.path);
    const real = await openResidentStore(db, source, verified, {
      expansionPath: realpathSync(expansion.path), rerankPath: realpathSync(rerank.path),
    });
    expect(real.internal.llm?.embedModelName).toBe(verified);
    expect(real.internal.llm?.generateModelName).toBe(realpathSync(expansion.path));
    expect(real.internal.llm?.rerankModelName).toBe(realpathSync(rerank.path));
    const calls: string[] = [];
    let fullArgs: { query?: string; queries?: unknown; rerank?: boolean; intent?: string; collection?: string; filter?: unknown; limit?: number } = {};
    const lex = await real.searchLex("padding margin", { collection: COLLECTION, limit: 2 });
    const hit = lex.find(item => item.displayPath.endsWith(two + ".md"));
    if (!hit) throw new Error("Missing synthetic hit");
    const session = (store: QMDStore): StoreSession => ({
      store, modelPath: verified, modelSha256: model.sha256, residency: "warm",
      expansionPath: realpathSync(expansion.path), expansionSha256: expansion.sha256,
      rerankPath: realpathSync(rerank.path), rerankSha256: rerank.sha256,
    });
    const wrapped: QMDStore = {
      ...real,
      close: async () => { calls.push("close"); },
      getStatus: async () => ({ totalDocuments: 2, needsEmbedding: 0, hasVectorIndex: true, pendingMetadata: 0, collections: [] }),
      search: async options => {
        calls.push("search");
        fullArgs = options;
        return [{ file: hit.filepath, displayPath: hit.displayPath, title: hit.title, body: hit.body ?? "",
          bestChunk: "", bestChunkPos: 0, score: 0.77, context: null, docid: hit.docid, metadata: hit.metadata }];
      },
      searchLex: async () => { calls.push("searchLex"); throw new Error("lexical fallback"); },
      searchVector: async () => { calls.push("searchVector"); throw new Error("vector fallback"); },
      embed: async () => { calls.push("embed"); throw new Error("embed"); },
      update: async () => { calls.push("update"); throw new Error("update"); },
      expandQuery: async () => { calls.push("expandQuery"); throw new Error("expand"); },
    };
    try {
      const full = await handleRequest({
        schema_version: 1, action: "search", mode: "full", vault_path: vault, db_path: db,
        query: "padding margin", limit: 2, allowed_ids: [two], semantic: fullSemantic(model, expansion, rerank),
      }, session(wrapped));
      const row = (full.results as { id: string; score: number; indexed_review_status?: string }[])[0];
      expect(row?.id).toBe(two);
      expect(row?.score).toBe(0.77);
      expect(row?.indexed_review_status).toBe("unreviewed");
      expect((full.engine as { mode: string; adapter_revision: string; remote_model_calls: number }).mode).toBe("full");
      expect((full.engine as { adapter_revision: string }).adapter_revision).toBe("onecard-qmd-v2");
      expect((full.engine as { remote_model_calls: number }).remote_model_calls).toBe(0);
      expect(fullArgs).toEqual({
        query: "padding margin", rerank: true, collection: COLLECTION,
        filter: { field: "permalink", operator: "in", value: [`knowledge/${two}`] }, limit: 2,
      });
      expect(fullArgs.queries).toBeUndefined();
      expect(fullArgs.intent).toBeUndefined();
      expect(calls).toEqual(["search"]);
      calls.length = 0;
      const empty = await handleRequest({
        schema_version: 1, action: "search", mode: "full", vault_path: vault, db_path: db,
        query: "padding", allowed_ids: [], semantic: fullSemantic(model, expansion, rerank),
      }, session(wrapped));
      expect(empty.results).toEqual([]);
      expect(calls).toEqual([]);
      wrapped.getStatus = async () => ({ totalDocuments: 2, needsEmbedding: 1, hasVectorIndex: false, pendingMetadata: 0, collections: [] });
      await expect(handleRequest({
        schema_version: 1, action: "search", mode: "full", vault_path: vault, db_path: db,
        query: "padding", semantic: fullSemantic(model, expansion, rerank),
      }, session(wrapped))).rejects.toMatchObject({ code: "embeddings_missing" });
      expect(calls).toEqual([]);
      await expect(handleRequest({
        schema_version: 1, action: "search", mode: "full", vault_path: vault, db_path: db,
        query: "padding", semantic: fullSemantic(model, { ...expansion, sha256: "d".repeat(64) }, rerank),
      }, session(wrapped))).rejects.toMatchObject({ code: "model_mismatch" });
      await expect(request("search", { query: "padding", mode: "full", semantic: fullSemantic(model, expansion, rerank) }))
        .rejects.toMatchObject({ code: "quality_models_missing" });
      await expect(request("search", { query: "padding", mode: "vector", semantic: fullSemantic(model, expansion, rerank) }))
        .rejects.toMatchObject({ code: "invalid_request" });
      expect(idsOf(await request("search", { query: "padding margin", limit: 2 }))).toEqual(lexicalIds);
    } finally { await real.close(); }
  });

  test("quality pins and default_mode are explicit and do not change auto", async () => {
    await request("index");
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const expansion = modelFile("expand.gguf", "GGUF-expansion");
    const rerank = modelFile("rerank.gguf", "GGUF-rerank");
    const plain = await openResidentStore(db, source, realpathSync(model.path));
    expect(plain.internal.llm?.generateModelName).not.toBe(realpathSync(expansion.path));
    expect(plain.internal.llm?.rerankModelName).not.toBe(realpathSync(rerank.path));
    await plain.close();
    const port = await freePort();
    await expect(startResident(writeConfig(port, writeToken(), model, contractCommand(), { expansion }))).rejects.toMatchObject({ code: "invalid_config" });
    for (const mode of ["auto", "hybrid", "FULL"]) {
      await expect(startResident(writeConfig(port, writeToken(), model, contractCommand(), { defaultMode: mode, expansion, rerank })))
        .rejects.toMatchObject({ code: "invalid_config" });
    }
    await expect(startResident(writeConfig(port, writeToken(), model, contractCommand(), { defaultMode: "full", expansion, rerank, unknown: true })))
      .rejects.toMatchObject({ code: "invalid_config" });
    const fake = modelFile("rerank-fake.gguf", "not a model");
    await expect(startResident(writeConfig(port, writeToken(), model, contractCommand(), { expansion, rerank: fake })))
      .rejects.toMatchObject({ code: "model_invalid" });
    expect(readFileSync(fake.path, "utf8")).toBe("not a model");
    const missing = { path: join(vault, "missing-rerank.gguf"), sha256: "e".repeat(64) };
    await expect(startResident(writeConfig(port, writeToken(), model, contractCommand(), { expansion, rerank: missing })))
      .rejects.toMatchObject({ code: "model_missing" });
    const resident = await startResident(writeConfig(port, writeToken(), model, contractCommand(), { defaultMode: "full", expansion, rerank }));
    residents.push(resident);
    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` } });
    const health = await healthResponse.json() as Record<string, unknown>;
    expect(healthResponse.status).toBe(200);
    expect(health).toEqual({
      schema_version: 1, status: "ok", vault_path: realpathSync(vault), embed_model_sha256: model.sha256,
      quality_models: { expansion_model_sha256: expansion.sha256, rerank_model_sha256: rerank.sha256 },
      engine: { name: "qmd", version: "2.8.3", upstream_commit: UPSTREAM_COMMIT, adapter_revision: "onecard-qmd-v2", mode: "lexical", remote_model_calls: 0 },
    });
    const healthText = JSON.stringify(health);
    expect(healthText).not.toContain(token);
    expect(healthText).not.toContain("expand.gguf");
    expect(healthText).not.toContain("resident.token");
    const lexical = await rpc(port);
    const automatic = await rpc(port, { mode: "auto" });
    expect((lexical.engine as { mode: string }).mode).toBe("lexical");
    expect((automatic.engine as { mode: string }).mode).toBe("lexical");
    expect(idsOf(lexical)).toEqual(idsOf(await request("search", { query: "padding margin", limit: 2 })));
    expect(idsOf(automatic)).toEqual(idsOf(lexical));
    await expect(rpc(port, { mode: "vector", semantic: semantic(model) })).rejects.toMatchObject({ code: "embeddings_missing" });
    await expect(rpc(port, { mode: "full", semantic: semantic(model) })).rejects.toMatchObject({ code: "quality_models_missing" });
    await expect(rpc(port, { mode: "full", semantic: fullSemantic(model, expansion, { ...rerank, sha256: "f".repeat(64) }) }))
      .rejects.toMatchObject({ code: "model_mismatch" });
    await expect(rpc(port, { mode: "full", semantic: fullSemantic(model, expansion, rerank) })).rejects.toMatchObject({ code: "embeddings_missing" });
    expect(resident.storesOpened()).toBe(1);
    expect(idsOf(await rpc(port))).toEqual(idsOf(lexical));
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

  test("resident status inventories current documents without inference", async () => {
    const absent = "33333333-3333-4333-8333-333333333333";
    const mismatch = "44444444-4444-4444-8444-444444444444";
    const oversize = "55555555-5555-4555-8555-555555555555";
    const broken = "77777777-7777-4777-8777-777777777777";
    const grown = "88888888-8888-4888-8888-888888888888";
    note(mismatch, "foreign permalink body");
    const mismatchPath = join(source, mismatch + ".md");
    writeFileSync(mismatchPath, readFileSync(mismatchPath, "utf8").replace(`knowledge/${mismatch}`, `knowledge/${one}`));
    writeFileSync(join(source, broken + ".md"),
      `---\nqmd: {metadata: {permalink: "knowledge/${broken}", card_version: "nope", source_version: "${version}"}}\n---\n\n# broken meta\n`);
    note(grown, "small atom");
    await request("index");
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const verified = realpathSync(model.path);
    const stdinStatus = await request("status");
    expect(Object.keys(stdinStatus).sort()).toEqual(["action", "engine", "latency_ms", "residency", "schema_version", "status"]);
    expect((await request("search", { query: "padding", allowed_ids: [] })).results).toEqual([]);
    await expect(request("status", { include_documents: true, allowed_ids: [one] })).rejects.toMatchObject({ code: "semantic_unconfigured" });
    await expect(handleRequest({
      schema_version: 1, action: "status", vault_path: vault, db_path: db,
      include_documents: true, allowed_ids: [one],
    }, { modelPath: verified, modelSha256: model.sha256, residency: "cold" })).rejects.toMatchObject({ code: "semantic_unconfigured" });
    await expect(request("search", { query: "padding", include_documents: true, allowed_ids: [one] })).rejects.toMatchObject({ code: "invalid_request" });
    const real = await openResidentStore(db, source, verified);
    const calls: string[] = [];
    const bodyGets: string[] = [];
    const session = (store: QMDStore): StoreSession => ({ store, modelPath: verified, modelSha256: model.sha256, residency: "warm" });
    const quiet = (store: QMDStore): QMDStore => ({
      ...store,
      close: async () => { calls.push("close"); },
      embed: async () => { calls.push("embed"); throw new Error("embed"); },
      update: async () => { calls.push("update"); throw new Error("update"); },
      search: async () => { calls.push("search"); throw new Error("search"); },
      searchLex: async () => { calls.push("searchLex"); throw new Error("searchLex"); },
      searchVector: async () => { calls.push("searchVector"); throw new Error("searchVector"); },
      expandQuery: async () => { calls.push("expandQuery"); throw new Error("expand"); },
    });
    const tracking: QMDStore = {
      ...quiet(real),
      get: async (path, options) => {
        const virtual = String(path);
        if (options?.includeBody) bodyGets.push(virtual);
        if (virtual.includes(oversize)) {
          if (options?.includeBody) throw new Error("oversize body loaded");
          return {
            filepath: `qmd://${COLLECTION}/${oversize}.md`,
            displayPath: `${COLLECTION}/${oversize}.md`,
            title: "hidden oversize title",
            context: null,
            hash: "e".repeat(64),
            docid: "eeeeee",
            collectionName: COLLECTION,
            modifiedAt: "2020-01-01",
            bodyLength: 1024 * 1024 + 1,
          };
        }
        return real.get(path, options);
      },
    };
    type Row = { id: string; sha256: string; indexed_hash: string; indexed_card_version: string; indexed_source_version: string };
    const inventoryRequest = (store: QMDStore, allowedIds: string[]) => handleRequest({
      schema_version: 1, action: "status", vault_path: vault, db_path: db,
      include_documents: true, allowed_ids: allowedIds,
    }, session(store));
    try {
      const plain = await handleRequest({ schema_version: 1, action: "status", vault_path: vault, db_path: db }, session(quiet(real)));
      expect(Object.keys(plain).sort()).toEqual(["action", "engine", "latency_ms", "residency", "schema_version", "status"]);
      expect(plain.status).toEqual(stdinStatus.status);
      expect(plain.status).toEqual(await real.getIndexHealth());
      await expect(handleRequest({
        schema_version: 1, action: "status", vault_path: vault, db_path: db,
        include_documents: true, allowed_ids: [one],
      }, { store: real, modelPath: verified, modelSha256: "", residency: "warm" })).rejects.toMatchObject({ code: "semantic_unconfigured" });
      await expect(handleRequest({
        schema_version: 1, action: "status", vault_path: vault, db_path: db,
        include_documents: "yes", allowed_ids: [one],
      }, session(real))).rejects.toMatchObject({ code: "invalid_request" });
      await expect(handleRequest({
        schema_version: 1, action: "status", vault_path: vault, db_path: db,
        include_documents: true, allowed_ids: [one], semantic: semantic(model),
      }, session(real))).rejects.toMatchObject({ code: "invalid_request" });

      const repeated = Array.from({ length: 256 }, () => one);
      await expect(inventoryRequest(real, [...repeated, one])).rejects.toMatchObject({ code: "invalid_ids" });
      await expect(inventoryRequest(real, [])).rejects.toMatchObject({ code: "invalid_ids" });
      await expect(handleRequest({
        schema_version: 1, action: "status", vault_path: vault, db_path: db, include_documents: true,
      }, session(real))).rejects.toMatchObject({ code: "invalid_ids" });
      await expect(inventoryRequest(real, ["../other"])).rejects.toMatchObject({ code: "invalid_ids" });

      const deduped = await inventoryRequest(tracking, repeated);
      expect((deduped.documents as Row[]).map(row => row.id)).toEqual([one]);
      expect(deduped.missing_ids).toEqual([]);

      writeFileSync(join(source, grown + ".md"), "x".repeat(1024 * 1024 + 1));
      const beforeTwo = readFileSync(join(source, two + ".md"), "utf8").replace(/\r\n/g, "\n");
      const listed = await inventoryRequest(tracking, [one, absent, one, mismatch, broken, grown, oversize, two]);
      const documents = listed.documents as Row[];
      expect(documents.map(row => row.id)).toEqual([one, two]);
      expect(listed.missing_ids).toEqual([absent, mismatch, broken, grown, oversize]);
      expect(listed.embed_model_sha256).toBe(model.sha256);
      expect(listed.vectors_ready).toBe(false);
      expect(listed.residency).toBe("warm");
      expect((listed.engine as { mode: string; remote_model_calls: number }).mode).toBe("lexical");
      expect((listed.engine as { remote_model_calls: number }).remote_model_calls).toBe(0);
      expect(listed.status).toEqual(plain.status);
      const fresh = documents[0];
      if (!fresh) throw new Error("Missing indexed document");
      const currentOne = readFileSync(join(source, one + ".md"), "utf8").replace(/\r\n/g, "\n");
      expect(Object.keys(fresh).sort()).toEqual(["id", "indexed_card_version", "indexed_hash", "indexed_source_version", "sha256"]);
      expect(fresh.sha256).toBe(createHash("sha256").update(currentOne).digest("hex"));
      expect(fresh.indexed_card_version).toBe(card);
      expect(fresh.indexed_source_version).toBe(version);
      const indexed = documents[1];
      if (!indexed) throw new Error("Missing second document");
      expect(indexed.sha256).toBe(createHash("sha256").update(beforeTwo).digest("hex"));
      expect(indexed.indexed_card_version).toBe(card);
      expect(bodyGets.some(path => path.includes(oversize) || path.includes(absent) || path.includes(grown))).toBe(false);
      const encoded = JSON.stringify(listed);
      for (const secret of ["padding", "foreign permalink", "broken meta", "hidden oversize", "nope", vault, "AgentNotes", model.path])
        expect(encoded).not.toContain(secret);

      const staleCard = "c".repeat(64);
      writeFileSync(join(source, two + ".md"), beforeTwo.replace(card, staleCard).replace("layout examples", "replaced examples"));
      const stale = await inventoryRequest(tracking, [two]);
      const staleRow = (stale.documents as Row[])[0];
      const staleFile = readFileSync(join(source, two + ".md"), "utf8").replace(/\r\n/g, "\n");
      expect(staleRow?.indexed_hash).toBe(indexed.indexed_hash);
      expect(staleRow?.indexed_card_version).toBe(card);
      expect(staleRow?.indexed_source_version).toBe(version);
      expect(staleRow?.indexed_card_version).not.toBe(staleCard);
      expect(staleRow?.sha256).toBe(createHash("sha256").update(staleFile).digest("hex"));
      expect(staleRow?.sha256).not.toBe(indexed.sha256);
      expect(staleRow?.sha256).not.toBe(staleRow?.indexed_hash);
      expect(JSON.stringify(stale)).not.toContain("replaced examples");

      const health = async (status: { totalDocuments: number; needsEmbedding: number; hasVectorIndex: boolean }) => {
        const wrapped: QMDStore = {
          ...quiet(real),
          getStatus: async () => ({ ...status, pendingMetadata: 0, collections: [] }),
        };
        const response = await inventoryRequest(wrapped, [one]);
        return response.vectors_ready;
      };
      expect(await health({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: true })).toBe(false);
      expect(await health({ totalDocuments: 2, needsEmbedding: 1, hasVectorIndex: true })).toBe(false);
      expect(await health({ totalDocuments: 2, needsEmbedding: 0, hasVectorIndex: false })).toBe(false);
      expect(await health({ totalDocuments: 2, needsEmbedding: 0, hasVectorIndex: true })).toBe(true);
      for (const name of ["embed", "update", "search", "searchLex", "searchVector", "expandQuery", "close"])
        expect(calls).not.toContain(name);
    } finally { await real.close(); }
  });

  test("loopback status inventory uses the resident pin", async () => {
    await request("index");
    const model = modelFile("embed.gguf", "GGUF-synthetic-fixture");
    const absent = "33333333-3333-4333-8333-333333333333";
    const { port } = await boot(model);
    const body = await callResident(`http://127.0.0.1:${port}`, token, {
      schema_version: 1, action: "status", vault_path: vault, db_path: db,
      include_documents: true, allowed_ids: [one, absent],
    });
    const row = (body.documents as { id: string; sha256: string; indexed_hash: string }[])[0];
    const current = readFileSync(join(source, one + ".md"), "utf8").replace(/\r\n/g, "\n");
    expect(body.embed_model_sha256).toBe(model.sha256);
    expect(body.vectors_ready).toBe(false);
    expect(row?.id).toBe(one);
    expect(row?.sha256).toBe(createHash("sha256").update(current).digest("hex"));
    expect(body.missing_ids).toEqual([absent]);
    expect(JSON.stringify(body)).not.toContain(vault);
    expect(JSON.stringify(body)).not.toContain("padding");
    const plain = await callResident(`http://127.0.0.1:${port}`, token, {
      schema_version: 1, action: "status", vault_path: vault, db_path: db,
    });
    expect(Object.keys(plain).sort()).toEqual(["action", "engine", "latency_ms", "residency", "schema_version", "status"]);
  });
});
