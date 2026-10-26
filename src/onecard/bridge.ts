/** One Card policy adapter. Indexing and ranking stay on the unmodified QMD SDK. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, closeSync, readSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createStore, type HybridQueryResult, type MetadataFilter, type QMDStore, type SearchResult } from "../index.js";
import { METADATA_FILTER_LIMITS } from "../metadata-filter.js";

export const UPSTREAM_COMMIT = "86d2365d17fc682e491c2c53d1e4a884aee8682a";
export const COLLECTION = "one-card-atoms";
export const MAX_REQUEST_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const GGUF = Buffer.from("GGUF");

export const ENGINE = {
  name: "qmd",
  version: "2.8.3",
  upstream_commit: UPSTREAM_COMMIT,
  adapter_revision: "onecard-qmd-v2",
  mode: "lexical" as const,
  remote_model_calls: 0,
};

export class AdapterError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export type StoreSession = {
  store: QMDStore;
  modelPath: string;
  modelSha256: string;
  residency: "cold" | "warm";
};

type RetrievalMode = "lexical" | "vector" | "rrf";
type ModelPin = { path: string; sha256: string };
type Hit = {
  displayPath: string;
  title: string;
  score: number;
  docid: string;
  metadata: SearchResult["metadata"];
  hash?: string;
  collectionName?: string;
  filepath?: string;
};

function fail(code: string, message: string): never { throw new AdapterError(code, message); }

export function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function guardArchive(path: string): void {
  for (let cursor = path; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, "ARCHIVED.json"))) fail("archived", "Restore the archived path before use.");
    if (dirname(cursor) === cursor) break;
  }
}

function symlinkBoundary(path: string): string {
  const lexical = resolve(tmpdir());
  if (path === lexical || path.startsWith(lexical + sep)) return lexical;
  try {
    const real = realpathSync(lexical);
    if (path === real || path.startsWith(real + sep)) return real;
  } catch { /* the temp root is checked only when it exists */ }
  return parse(path).root;
}

function rejectSymlinkChain(path: string): void {
  const abs = resolve(path);
  const stop = symlinkBoundary(abs);
  let cursor = abs;
  while (cursor !== stop && dirname(cursor) !== cursor) {
    let info;
    try { info = lstatSync(cursor); }
    catch { return; }
    if (info.isSymbolicLink()) fail("path_escape", "Symlinks are not authorized.");
    cursor = dirname(cursor);
  }
}

function guardInside(root: string, path: string): void {
  guardArchive(path);
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (!contained(root, realpathSync(existing))) fail("path_escape", "Path leaves the authorized vault.");
}

function absolute(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) fail("invalid_path", "An absolute local path is required.");
  return resolve(value);
}

export function canonicalVault(value: unknown): string {
  const requested = absolute(value);
  guardArchive(requested);
  rejectSymlinkChain(requested);
  if (!existsSync(requested)) fail("invalid_path", "An absolute local path is required.");
  return realpathSync(requested);
}

export function resolveGuardedFile(value: unknown, missingCode: string): string {
  const requested = absolute(value);
  guardArchive(requested);
  rejectSymlinkChain(requested);
  if (!existsSync(requested)) fail(missingCode, "The local file is missing.");
  const resolved = realpathSync(requested);
  if (!statSync(resolved).isFile()) fail(missingCode, "The local file is missing.");
  return resolved;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  return present.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on("data", chunk => { hash.update(chunk); });
    stream.on("error", reject);
    stream.on("end", () => resolveHash());
  });
  return hash.digest("hex");
}

function assertGguf(path: string): void {
  const fd = openSync(path, "r");
  const header = Buffer.alloc(4);
  try {
    const read = readSync(fd, header, 0, 4, 0);
    if (read !== 4 || !header.equals(GGUF)) fail("model_invalid", "The pinned model file is not a local GGUF and was left in place.");
  } finally { closeSync(fd); }
}

export async function verifyEmbedModel(pin: { path: string; sha256: string }): Promise<ModelPin> {
  if (typeof pin.sha256 !== "string" || !HASH.test(pin.sha256)) fail("model_mismatch", "The embedding model digest is invalid.");
  const requested = absolute(pin.path);
  guardArchive(requested);
  rejectSymlinkChain(requested);
  if (!existsSync(requested)) fail("model_missing", "The pinned local embedding model is missing.");
  if (!lstatSync(requested).isFile()) fail("model_invalid", "The pinned model file is not a local GGUF and was left in place.");
  const path = realpathSync(requested);
  const sha256 = await sha256File(path);
  if (sha256 !== pin.sha256) fail("model_mismatch", "The local embedding model does not match the pinned digest.");
  assertGguf(path);
  return { path, sha256 };
}

function engine(mode: RetrievalMode): Record<string, unknown> {
  return { ...ENGINE, mode, remote_model_calls: 0 };
}

function finish(action: string, mode: RetrievalMode, extra: Record<string, unknown>, residency: "cold" | "warm", started: number): Record<string, unknown> {
  return {
    schema_version: 1,
    action,
    engine: engine(mode),
    residency,
    latency_ms: Math.max(0, Math.round(performance.now() - started)),
    ...extra,
  };
}

function resolveMode(action: string, value: unknown): RetrievalMode {
  if (action === "embed") {
    if (value !== undefined) fail("invalid_request", "Embed is the explicit action and does not take a search mode.");
    return "vector";
  }
  if (value === undefined || value === "lexical" || value === "auto") return "lexical";
  if (value === "vector" || value === "rrf") return value;
  fail("mode_unavailable", value === "hybrid"
    ? "Hybrid mode is not available. Use explicit rrf for lex and vector fusion without expansion or reranking."
    : "Use an explicit lexical, vector, or rrf mode.");
}

function readRequestModel(value: unknown): { path: string; sha256: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request", "Semantic requests carry only the embedding model pin.");
  const semantic = value as Record<string, unknown>;
  if (!exactKeys(semantic, ["embed_model"])) fail("invalid_request", "Semantic requests carry only the embedding model pin.");
  const model = semantic.embed_model;
  if (!model || typeof model !== "object" || Array.isArray(model)) fail("invalid_request", "Semantic requests carry only the embedding model pin.");
  const pin = model as Record<string, unknown>;
  if (!exactKeys(pin, ["path", "sha256"]) || typeof pin.path !== "string" || typeof pin.sha256 !== "string")
    fail("invalid_request", "Semantic requests carry only the embedding model pin.");
  return { path: pin.path, sha256: pin.sha256 };
}

function allowFilter(allowed: string[] | undefined): MetadataFilter | undefined {
  if (!allowed || allowed.length === 0) return undefined;
  const groups: MetadataFilter[] = [];
  for (let i = 0; i < allowed.length; i += METADATA_FILTER_LIMITS.maxMembershipValues) {
    groups.push({
      field: "permalink",
      operator: "in",
      value: allowed.slice(i, i + METADATA_FILTER_LIMITS.maxMembershipValues).map(id => "knowledge/" + id),
    });
  }
  let level = groups;
  while (level.length > METADATA_FILTER_LIMITS.maxGroupOperands) {
    const next: MetadataFilter[] = [];
    for (let i = 0; i < level.length; i += METADATA_FILTER_LIMITS.maxGroupOperands)
      next.push({ operator: "or", operands: level.slice(i, i + METADATA_FILTER_LIMITS.maxGroupOperands) });
    level = next;
  }
  if (level.length === 1) return level[0];
  if (level.length > 1) return { operator: "or", operands: level };
  return undefined;
}

function fromSearch(hit: SearchResult): Hit {
  return {
    displayPath: hit.displayPath, title: hit.title, score: hit.score, docid: hit.docid,
    metadata: hit.metadata, hash: hit.hash, collectionName: hit.collectionName, filepath: hit.filepath,
  };
}

function fromHybrid(hit: HybridQueryResult): Hit {
  return {
    displayPath: hit.displayPath, title: hit.title, score: hit.score, docid: hit.docid,
    metadata: hit.metadata, filepath: hit.file,
  };
}

async function materialize(store: QMDStore, hit: Hit, vault: string, source: string): Promise<Record<string, unknown>> {
  const id = basename(hit.displayPath).replace(/\.md$/, "");
  let collection = hit.collectionName;
  if (!collection && hit.filepath?.startsWith("qmd://")) collection = hit.filepath.slice("qmd://".length).split("/")[0];
  if (!UUID.test(id) || collection !== COLLECTION) fail("index_identity", "Unexpected document identity in the managed collection.");
  let hash = hit.hash;
  if (!hash) {
    const found = await store.get(hit.filepath ?? hit.docid, { includeBody: false });
    if (!found || typeof found !== "object" || "error" in found || found.collectionName !== COLLECTION)
      fail("index_identity", "Unexpected document identity in the managed collection.");
    hash = found.hash;
  }
  const file = join(source, id + ".md");
  guardInside(vault, file);
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const card = hit.metadata.card_version;
  const version = hit.metadata.source_version;
  if (typeof card !== "string" || typeof version !== "string" || !HASH.test(card) || !HASH.test(version))
    fail("index_metadata", "Indexed source versions are missing.");
  const row: Record<string, unknown> = {
    id, path: `AgentNotes/Atoms/${id}.md`, title: hit.title, score: hit.score,
    docid: hit.docid, indexed_hash: hash,
    sha256: createHash("sha256").update(text).digest("hex"),
    indexed_card_version: card, indexed_source_version: version,
  };
  if (typeof hit.metadata.review_status === "string") row.indexed_review_status = hit.metadata.review_status;
  return row;
}

export async function openResidentStore(db: string, source: string, modelPath: string): Promise<QMDStore> {
  return createStore({
    dbPath: db,
    config: {
      collections: { [COLLECTION]: { path: source, pattern: "*.md" } },
      models: { embed: modelPath },
    },
  });
}

export async function handleRequest(value: unknown, session?: StoreSession): Promise<Record<string, unknown>> {
  const started = performance.now();
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request", "Expected one JSON object.");
  const request = value as Record<string, unknown>;
  for (const key of ["intent", "queries", "rerank", "expand", "hyde"]) {
    if (request[key] !== undefined) fail("invalid_request", "Query rewriting and reranking are not accepted.");
  }
  if (request.schema_version !== 1 || !["index", "search", "status", "embed"].includes(String(request.action)))
    fail("invalid_request", "Unknown protocol or action.");
  const action = String(request.action);
  const mode = resolveMode(action, request.mode);
  if ((action === "index" || action === "status") && mode !== "lexical")
    fail("mode_unavailable", "Index and status stay lexical.");
  const vault = canonicalVault(request.vault_path);
  const source = join(vault, "AgentNotes", "Atoms");
  guardInside(vault, source);
  if (!existsSync(source)) fail("source_missing", "The managed English atom directory is missing.");
  const db = absolute(request.db_path);
  if (!samePath(db, join(vault, ".knowledge", "qmd", "index.sqlite"))) fail("invalid_db", "Use the dedicated vault QMD index.");
  guardInside(vault, db);
  let allowed: string[] | undefined;
  if (request.allowed_ids !== undefined) {
    if (!Array.isArray(request.allowed_ids) || request.allowed_ids.length > 5000) fail("invalid_ids", "Invalid current document IDs.");
    const ids: string[] = [];
    for (const id of request.allowed_ids) {
      if (typeof id !== "string" || !UUID.test(id)) fail("invalid_ids", "Invalid current document IDs.");
      ids.push(id);
    }
    allowed = [...new Set(ids)];
  }
  let query = "";
  let limit = 12;
  if (action === "search") {
    const rawLimit = request.limit === undefined ? 12 : request.limit;
    if (typeof request.query !== "string" || !request.query.trim() || request.query.length > 1000 ||
        typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 60)
      fail("invalid_query", "Invalid query or result limit.");
    query = request.query;
    limit = rawLimit;
  }
  const wantsSemantic = action === "embed" || (action === "search" && (mode === "vector" || mode === "rrf"));
  if (wantsSemantic && request.semantic === undefined) fail("semantic_unconfigured", "Explicit semantic operations require a local embedding model pin.");
  if (!wantsSemantic && request.semantic !== undefined) fail("invalid_request", "Semantic model pins are only accepted for vector, rrf, and embed.");
  const pin = wantsSemantic ? await verifyEmbedModel(readRequestModel(request.semantic)) : undefined;
  if (pin && session && (!samePath(session.modelPath, pin.path) || session.modelSha256 !== pin.sha256))
    fail("model_mismatch", "The request model does not match the pinned resident model.");
  if (action !== "index" && !existsSync(db)) fail("index_missing", "Initialize the dedicated QMD index explicitly.");

  let store: QMDStore | undefined;
  let owned = false;
  try {
    if (action === "index") {
      if (session) fail("action_unavailable", "Index and embed remain explicit stdin actions.");
      mkdirSync(dirname(db), { recursive: true });
      store = await createStore({ dbPath: db, config: { collections: { [COLLECTION]: { path: source, pattern: "*.md" } } } });
      owned = true;
      return finish(action, "lexical", { update: await store.update({ collections: [COLLECTION] }) }, "cold", started);
    }
    if (session) store = session.store;
    else if (pin) {
      store = await openResidentStore(db, source, pin.path);
      owned = true;
    } else {
      store = await createStore({ dbPath: db });
      owned = true;
    }
    const residency = session?.residency ?? "cold";
    const collection = (await store.listCollections()).find(item => item.name === COLLECTION);
    if (!collection || !samePath(realpathSync(collection.pwd), realpathSync(source)))
      fail("index_identity", "QMD index belongs to a different collection.");
    if (action === "status") return finish(action, "lexical", { status: await store.getIndexHealth() }, residency, started);
    if (action === "embed") {
      if (!pin) fail("semantic_unconfigured", "Explicit semantic operations require a local embedding model pin.");
      const embedded = await store.embed({ model: pin.path, collection: COLLECTION });
      if (embedded.errors > 0) fail("embed_failed", "Local embedding did not finish for every pending document.");
      return finish(action, "vector", { embed: {
        docsProcessed: embedded.docsProcessed,
        chunksEmbedded: embedded.chunksEmbedded,
        chunksCopied: embedded.chunksCopied,
        errors: embedded.errors,
        durationMs: embedded.durationMs,
      } }, residency, started);
    }
    if (mode === "vector" || mode === "rrf") {
      const health = await store.getStatus();
      if (health.totalDocuments > 0 && (health.needsEmbedding > 0 || !health.hasVectorIndex))
        fail("embeddings_missing", "The pinned local model has no current embeddings for this index.");
    }
    if (allowed?.length === 0) return finish(action, mode, { results: [] }, residency, started);
    const filter = allowFilter(allowed);
    const hits = mode === "vector"
      ? (await store.searchVector(query, { limit, collection: COLLECTION, filter })).map(fromSearch)
      : mode === "rrf"
        ? (await store.search({
            queries: [{ type: "lex", query }, { type: "vec", query }],
            rerank: false,
            collection: COLLECTION,
            filter,
            limit,
          })).map(fromHybrid)
        : (await store.searchLex(query, { limit, collection: COLLECTION, filter })).map(fromSearch);
    const results = [];
    for (const hit of hits) results.push(await materialize(store, hit, vault, source));
    return finish(action, mode, { results }, residency, started);
  } finally { if (owned && store) await store.close(); }
}
