// Explicit, local-only comparison with an immutable upstream worktree.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { handleRequest, UPSTREAM_COMMIT, COLLECTION } from "../src/onecard/bridge.ts";

const [vaultArg, baselineArg, casesArg, outputArg] = process.argv.slice(2);
if (!vaultArg || !baselineArg || !casesArg || !outputArg)
  throw new Error("Usage: bun scripts/onecard-compare.mjs VAULT UPSTREAM_WORKTREE CASES_JSON OUTPUT_JSON");
const vault = resolve(vaultArg), baseline = resolve(baselineArg);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseline, encoding: "utf8" }).trim();
if (head !== UPSTREAM_COMMIT) throw new Error("Baseline is not the pinned upstream commit");
execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "src"], { cwd: baseline });
const { createStore } = await import(pathToFileURL(join(baseline, "src", "index.ts")).href);
if (existsSync(join(vault,"ARCHIVED.json"))) throw new Error("Restore archived vault first");
mkdirSync(join(vault,".knowledge","qmd-upstream"),{recursive:true});
const store = await createStore({ dbPath: join(vault, ".knowledge", "qmd-upstream", "index.sqlite"),
  config: { collections: { [COLLECTION]: { path: join(vault, "AgentNotes", "Atoms"), pattern: "*.md" } } } });
const spec = JSON.parse(readFileSync(casesArg, "utf8"));
const rows = [];
try {
  const baselineIndex = await store.update({ collections: [COLLECTION] });
  for (const item of spec.cases) {
    for (const language of ["ko", "en"]) {
      const query = item[language];
      const expected = await store.searchLex(query, { collection: COLLECTION, limit: 5 });
      const response = await handleRequest({ schema_version: 1, action: "search", vault_path: vault,
        db_path: join(vault, ".knowledge", "qmd", "index.sqlite"), query, limit: 5 });
      const actual = response.results;
      const same = JSON.stringify(expected.map(x => [x.docid, x.score])) === JSON.stringify(actual.map(x => [x.docid, x.score]));
      rows.push({ key: item.key, language, query, same_order_and_scores: same,
        baseline: expected.map(x => ({ docid: x.docid, title: x.title, score: x.score })),
        fork: actual.map(x => ({ docid: x.docid, title: x.title, score: x.score })) });
      if (!same) throw new Error("Adapter changed upstream ranking");
    }
  }
  const result = { upstream_commit: UPSTREAM_COMMIT, baseline_index: baselineIndex,
    comparison: "Two independent indexes of identical Markdown; untouched upstream worktree SDK versus fork adapter. No model inference or query rewrite.",
    queries: rows.length, same_order_and_scores: rows.filter(x => x.same_order_and_scores).length, rows };
  writeFileSync(outputArg, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ queries: rows.length, same_order_and_scores: result.same_order_and_scores,
    baseline_documents: baselineIndex.indexed + baselineIndex.updated + baselineIndex.unchanged, remote_model_calls: 0 }));
} finally { await store.close(); }
