# One Card specialization

This is a real fork of [tobi/qmd](https://github.com/tobi/qmd), pinned to upstream
commit `86d2365d17fc682e491c2c53d1e4a884aee8682a` (package version 2.8.3).
The upstream MIT license, source history, SDK, CLI, MCP, tests and skills remain.

The derived skill now requests body-first, version-checked reads and explicit
source-section attribution from the caller's One Card integration. The caller's
current contract is `one-card-consume-v2`; its MCP launcher uses a fresh read-only
worker per call. These are caller-side changes, not replacements for QMD search.

## Boundary

- `src/onecard/bridge.ts`: adapter over the SDK. `lexical`, `vector`, and `rrf`
  use the query as written. `full` calls upstream `store.search` with rerank on.
  A strong BM25 hit can skip expansion, so rewriting is not guaranteed. No custom
  ranking and no direct database writes.
- `src/onecard/cli.ts`: one JSON request on stdin, or `--serve --config` for the
  loopback resident. A query does not embed the corpus, download a model, or
  start that process.
- `skills/onecard`: an explicitly invoked adaptation of the upstream QMD skill.
- `test/onecard.test.ts`: real temporary-file SDK integration and boundary checks.
- `scripts/onecard-compare.mjs`: compare an untouched upstream checkout against
  this adapter using two independent indexes of the same Markdown.

No changes to upstream search/index/model/MCP implementations are necessary.
The consuming application retains its original-source integrity checks and
human study views. The adapter does not claim that translated text is verified.

## Protocol v1

Run `bun dist/onecard/cli.js` after `bun install --frozen-lockfile` and
`bun run build`. Send a JSON object with `schema_version:1`, action
`index|search|status|embed`, and absolute `vault_path` and `db_path`.
The database must be `VAULT/.knowledge/qmd/index.sqlite`; the only collection is
`VAULT/AgentNotes/Atoms/*.md`, named `one-card-atoms`.

`index` and `embed` are explicit authorized operations. `index` uses QMD's SDK,
does not run collection update hooks or source commands, and does not embed.
`search` and `status` require an existing initialized index and never reindex,
embed, download, or start the resident.
The separate application ingestion hook updates the index when card file hashes
change. A query does not repair a stale index by itself.

Search takes `query` (1–1000 characters), `limit` (1–60) and optional
`allowed_ids` (canonical UUIDs). An empty allowlist matches nothing. Eligibility
uses QMD's native metadata filter on `permalink`; large allowlists are represented
within upstream filter limits. There are no topic/concept exclusion gates.

Generated documents opt into the upstream format `qmd.metadata`, containing
permalink, card_version, source_version, language and review_status. Results
expose those indexed versions, native docid/score/hash, and a fresh LF-normalized
file SHA-256. The application rejects stale versions, changed files and inactive
source dependencies without re-ranking the surviving results.

Unset mode and native `auto` are lexical. Optional top-level `default_mode`
(`lexical`, `vector`, `rrf`, or `full`) is applied by the parent before the
request. `auto` is not a config value. `hybrid` fails with `mode_unavailable`.

- `lexical`: `searchLex` of the query as written.
- `vector`: `searchVector` of that same query, without expansion or rerank.
- `rrf`: lex plus vector fusion of that same query with rerank off.
- `full`: `store.search({ query, rerank: true })`. Upstream expansion plus rerank
  is conditional; a strong BM25 hit can skip rewriting. Scores stay that
  pipeline's native scores.

`vector`, `rrf`, and `full` require current embeddings. Semantic config may add
only `expansion_model` and `rerank_model`, together. `full` needs both; a missing
pin is `quality_models_missing`, not a lexical fallback. Maintenance settings
belong in `qmd-maintenance.json`, not in semantic keys. A separate private
snapshot confirmed vector, RRF, and full GGUF inference for three preselected
queries, without production activation. Those queries, model paths, and data
are not recorded here.

## Updating and validating

Keep upstream changes on the upstream branch and specialization on `one-card`.
Before merging a newer upstream commit, re-run adapter tests, metadata and SDK
checks, source-version guards and the identical-corpus comparison. Update the
provenance pin deliberately; do not silently track a mutable package release.

The comparison takes explicit local paths; it never uploads the corpus:

    bun scripts/onecard-compare.mjs VAULT UPSTREAM_WORKTREE CASES_JSON OUTPUT_JSON

The upstream worktree must be at the pinned commit with unchanged tracked source.
Do not commit user questions, index databases, private paths, notes or outputs.

The Windows test run found an existing failure in the upstream CJK migration
source-scan assertion at this base commit; its source and test are unchanged.
Lexical runtime tests and the adapter's native-order comparison are separate
checks. The full SDK suite includes local-model paths and is not claimed as
fully tested by this specialization.
