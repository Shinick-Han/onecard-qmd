import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createStore } from "../src/index.js";
import { handleRequest, COLLECTION } from "../src/onecard/bridge.js";

let vault: string, db: string, source: string;
const one = "11111111-1111-4111-8111-111111111111", two = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64), version = "b".repeat(64);
function note(id: string, body: string, crlf = false): void {
  let text = `---\nqmd: {metadata: {permalink: "knowledge/${id}", card_version: "${hash}", source_version: "${version}"}}\n---\n\n# ${body}\n\n${body}\n`;
  if (crlf) text = text.replace(/\n/g, "\r\n");
  writeFileSync(join(source, id + ".md"), text);
}
function request(action: string, extra = {}) {
  return handleRequest({ schema_version: 1, action, vault_path: vault, db_path: db, ...extra });
}
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "onecard-qmd-"));
  source = join(vault, "AgentNotes", "Atoms"); mkdirSync(source, { recursive: true });
  db = join(vault, ".knowledge", "qmd", "index.sqlite");
  note(one, "padding margin crowded layout"); note(two, "padding margin layout examples");
});
afterEach(async () => {
  // Explicit test-owned temporary root; never a user vault.
  if (!vault.startsWith(join(tmpdir(), "onecard-qmd-"))) throw new Error("Unexpected test root");
  await Bun.sleep(20);
  Bun.gc(true); // Release Bun SQLite statements before Windows removes temp DBs.
  try { rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
  catch (error) {
    // Like the upstream SDK fixture cleanup: Bun may retain a Windows
    // directory handle past close(). Preserve the temp fixture in that case;
    // do not hide assertion failures or swallow other filesystem errors.
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
    console.warn("One Card test fixture cleanup deferred: Windows/Bun directory handle is still open.");
  }
});

describe("One Card specialization delegates to QMD", () => {
  test("native upstream SDK order and scores are unchanged", async () => {
    await request("index");
    const actual = await request("search", { query: "padding margin", limit: 2 });
    const native = await createStore({ dbPath: db });
    try {
      const expected = await native.searchLex("padding margin", { collection: COLLECTION, limit: 2 });
      expect((actual.results as any[]).map(x => [x.docid, x.score])).toEqual(expected.map(x => [x.docid, x.score]));
    } finally { await native.close(); }
    expect((actual.engine as any).remote_model_calls).toBe(0);
  });
  test("current identity filtering and empty allowlist use native filters", async () => {
    await request("index");
    expect((await request("search", { query: "padding", allowed_ids: [] })).results).toEqual([]);
    const ids = Array.from({ length: 266 }, (_, i) => `${i.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    const result = await request("search", { query: "padding", allowed_ids: [...ids, two] });
    expect((result.results as any[]).map(x => x.id)).toEqual([two]);
  });
  test("CRLF hash normalization and indexed versions are explicit", async () => {
    note(one, "padding margin", true); await request("index");
    const result = await request("search", { query: "padding", allowed_ids: [one] });
    const hit = (result.results as any[])[0];
    const content = readFileSync(join(source, one + ".md"), "utf8").replace(/\r\n/g, "\n");
    expect(hit.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(hit.indexed_card_version).toBe(hash); expect(hit.indexed_source_version).toBe(version);
    writeFileSync(join(source, one + ".md"), content.replace(hash, "c".repeat(64)));
    const stale = ((await request("search", { query: "padding", allowed_ids: [one] })).results as any[])[0];
    expect(stale.indexed_card_version).toBe(hash); expect(stale.sha256).not.toBe(hit.sha256);
  });
  test("search never indexes newly added files", async () => {
    await request("index"); note("33333333-3333-4333-8333-333333333333", "uniquelynewtoken");
    expect((await request("search", { query: "uniquelynewtoken" })).results).toEqual([]);
  });
  test("missing index and unsupported modes are explicit errors", async () => {
    await expect(request("search", { query: "padding" })).rejects.toMatchObject({ code: "index_missing" });
    await expect(request("search", { query: "padding", mode: "hybrid" })).rejects.toMatchObject({ code: "mode_unavailable" });
  });
  test("invalid identities, paths and archived roots are refused", async () => {
    await request("index");
    await expect(request("search", { query: "padding", allowed_ids: ["../other"] })).rejects.toMatchObject({ code: "invalid_ids" });
    await expect(request("search", { query: "padding", db_path: join(vault, "other.sqlite") })).rejects.toMatchObject({ code: "invalid_db" });
    writeFileSync(join(vault, "ARCHIVED.json"), "{}");
    await expect(request("search", { query: "padding" })).rejects.toMatchObject({ code: "archived" });
  });
  test("a collection junction escaping the vault is refused", async () => {
    await request("index");
    const outside = mkdtempSync(join(tmpdir(), "onecard-outside-"));
    try {
      if (!source.startsWith(vault)) throw new Error("Unexpected test source");
      rmSync(source, { recursive: true, force: true }); symlinkSync(outside, source, "junction");
      await expect(request("search", { query: "padding", allowed_ids: [one] })).rejects.toMatchObject({ code: "path_escape" });
    } finally {
      if (!outside.startsWith(join(tmpdir(), "onecard-outside-"))) throw new Error("Unexpected test target");
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
