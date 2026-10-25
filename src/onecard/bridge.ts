/** One Card policy adapter. Indexing and ranking are the unmodified QMD SDK. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createStore, type MetadataFilter } from "../index.js";
import { METADATA_FILTER_LIMITS } from "../metadata-filter.js";

export const UPSTREAM_COMMIT = "86d2365d17fc682e491c2c53d1e4a884aee8682a";
export const COLLECTION = "one-card-atoms";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const ENGINE = { name: "qmd", version: "2.8.3", upstream_commit: UPSTREAM_COMMIT,
  adapter_revision: "onecard-qmd-v1", mode: "lexical", remote_model_calls: 0 };

export class AdapterError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new AdapterError(code, message); }
function same(a: string, b: string): boolean {
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

export async function handleRequest(value: unknown): Promise<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request", "Expected one JSON object.");
  const r = value as Record<string, unknown>;
  if (r.schema_version !== 1 || !["index", "search", "status"].includes(String(r.action)))
    fail("invalid_request", "Unknown protocol or action.");
  if (r.mode !== undefined && r.mode !== "lexical") fail("mode_unavailable", "Use QMD's explicit model setup before enabling semantic retrieval.");
  const requested = absolute(r.vault_path); guardArchive(requested);
  const vault = realpathSync(requested);
  const source = join(vault, "AgentNotes", "Atoms"); guardInside(vault, source);
  if (!existsSync(source)) fail("source_missing", "The managed English atom directory is missing.");
  const db = absolute(r.db_path);
  if (!same(db, join(vault, ".knowledge", "qmd", "index.sqlite"))) fail("invalid_db", "Use the dedicated vault QMD index.");
  guardInside(vault, db);
  const index = r.action === "index";
  if (!index && !existsSync(db)) fail("index_missing", "Initialize the dedicated QMD index explicitly.");
  let allowed: string[] | undefined;
  if (r.allowed_ids !== undefined) {
    if (!Array.isArray(r.allowed_ids) || r.allowed_ids.length > 5000 ||
        !r.allowed_ids.every(x => typeof x === "string" && UUID.test(x))) fail("invalid_ids", "Invalid current document IDs.");
    allowed = [...new Set(r.allowed_ids as string[])];
  }
  const limit = r.limit ?? 12;
  if (r.action === "search" && (typeof r.query !== "string" || !r.query.trim() || r.query.length > 1000 ||
      !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 60)) fail("invalid_query", "Invalid query or result limit.");
  if (index) mkdirSync(dirname(db), { recursive: true });
  const store = await createStore({ dbPath: db, ...(index ? { config: { collections: {
    [COLLECTION]: { path: source, pattern: "*.md" },
  } } } : {}) });
  try {
    if (index) return { schema_version: 1, action: r.action, engine: ENGINE,
      update: await store.update({ collections: [COLLECTION] }) };
    const collection = (await store.listCollections()).find(c => c.name === COLLECTION);
    if (!collection || !same(realpathSync(collection.pwd), realpathSync(source))) fail("index_identity", "QMD index belongs to a different collection.");
    if (r.action === "status") return { schema_version: 1, action: r.action, engine: ENGINE,
      status: await store.getIndexHealth() };
    if (allowed?.length === 0) return { schema_version: 1, action: r.action, engine: ENGINE, results: [] };
    const groups: MetadataFilter[] = [];
    if (allowed) for (let i = 0; i < allowed.length; i += METADATA_FILTER_LIMITS.maxMembershipValues) {
      groups.push({ field: "permalink", operator: "in",
        value: allowed.slice(i, i + METADATA_FILTER_LIMITS.maxMembershipValues).map(id => "knowledge/" + id) });
    }
    let level = groups;
    while (level.length > METADATA_FILTER_LIMITS.maxGroupOperands) {
      const next: MetadataFilter[] = [];
      for (let i = 0; i < level.length; i += METADATA_FILTER_LIMITS.maxGroupOperands)
        next.push({ operator: "or", operands: level.slice(i, i + METADATA_FILTER_LIMITS.maxGroupOperands) });
      level = next;
    }
    const filter: MetadataFilter | undefined = level.length > 1 ? { operator: "or", operands: level } : level[0];
    const hits = await store.searchLex(r.query as string, { limit: Number(limit), collection: COLLECTION, filter });
    const results = [];
    for (const hit of hits) {
      const id = basename(hit.displayPath).replace(/\.md$/, "");
      if (!UUID.test(id) || hit.collectionName !== COLLECTION) fail("index_identity", "Unexpected document identity in the managed collection.");
      const file = join(source, id + ".md"); guardInside(vault, file);
      const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const card = hit.metadata.card_version, version = hit.metadata.source_version;
      if (typeof card !== "string" || typeof version !== "string" || !HASH.test(card) || !HASH.test(version))
        fail("index_metadata", "Indexed source versions are missing.");
      results.push({ id, path: `AgentNotes/Atoms/${id}.md`, title: hit.title, score: hit.score,
        docid: hit.docid, indexed_hash: hit.hash,
        sha256: createHash("sha256").update(text).digest("hex"),
        indexed_card_version: card, indexed_source_version: version });
    }
    return { schema_version: 1, action: r.action, engine: ENGINE, results };
  } finally { await store.close(); }
}
