# One Card specialization

This is a real fork of [tobi/qmd](https://github.com/tobi/qmd), pinned to upstream
commit `86d2365d17fc682e491c2c53d1e4a884aee8682a` (package version 2.8.3).
The upstream MIT license, source history, SDK, CLI, MCP, tests and skills remain.

The derived skill now requests body-first, version-checked reads and explicit
source-section attribution from the caller's One Card integration. The caller's
current contract is `one-card-consume-v2`; its MCP launcher uses a fresh read-only
worker per call. These are caller-side changes, not replacements for QMD search.

## Boundary

- `src/onecard/bridge.ts`: a small adapter over `createStore`, `update` and
  `searchLex`. No query translation, ranking, synonym expansion, graph algorithm
  or direct database writes.
- `src/onecard/cli.ts`: one JSON request on stdin; one response on stdout.
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
`index|search|status`, and absolute `vault_path` and `db_path`.
The database must be `VAULT/.knowledge/qmd/index.sqlite`; the only collection is
`VAULT/AgentNotes/Atoms/*.md`, named `one-card-atoms`.

`index` is an explicit authorized ingestion operation. It uses QMD's SDK, does
not run collection update hooks or source commands, and does not embed or infer.
`search` and `status` require an existing initialized index and never reindex.
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

Only `lexical` mode is enabled by this adapter. The original QMD vector, hybrid
and reranking implementations remain available upstream; they require explicit
local-model preparation and have not been validated by this lexical migration.
Unsupported modes fail clearly, with no hidden substitute engine.

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
