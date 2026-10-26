# One Card semantic protocol

Lexical retrieval remains the default on the wire. This adapter adds explicit
`vector`, `rrf`, and `full` modes and a loopback resident process. `vector` and
`rrf` do not expand queries or call the reranker. `full` calls the unmodified
upstream pipeline `store.search({ query, rerank: true, collection, filter, limit })`.
Upstream search, indexing, and model code are unchanged. The upstream pin remains
`86d2365d17fc682e491c2c53d1e4a884aee8682a`.

`schema_version` remains `1`. Successful engines use:

- `adapter_revision`: `onecard-qmd-v2`
- `mode`: the mode actually used, `lexical`, `vector`, `rrf`, or `full`
- `remote_model_calls`: `0`

`mode: "auto"` is legacy and stays lexical, including when runtime `default_mode`
is `full`. The parent resolves its configured default before the request.
`mode: "hybrid"` is rejected with `mode_unavailable`. RRF is lex plus vector
fusion of the original query only. It is not QMD's full hybrid pipeline. `full`
is that upstream pipeline: conditional expansion plus rerank. A strong BM25 hit
can skip rewriting, so expansion is not guaranteed for every query.

Scores are the SDK's native relevance values. They are not truth or confidence.
Every mode keeps the current-document allow list, collection identity check,
LF-normalized source SHA-256, and indexed `card_version` / `source_version`.
`review_status` is copied through as `indexed_review_status` when it is a string.
Unreviewed documents are not dropped.

## Runtime config

`schema_version`, `upstream_commit`, `command`, and `semantic` are required for
`--serve`. `command` is the parent argv `[bunExecutable, dist/onecard/cli.js]`:
exactly two absolute paths to existing files. The server keeps that array and
does not execute it. Optional `default_mode` is `lexical`, `vector`, `rrf`, or
`full`. `auto` is not a config value. The server validates `default_mode` and
does not use it to change a request. Semantic config is optional for stdin
lexical use and required for `--serve`:

```json
{
  "schema_version": 1,
  "upstream_commit": "86d2365d17fc682e491c2c53d1e4a884aee8682a",
  "command": ["/absolute/bun", "/absolute/dist/onecard/cli.js"],
  "semantic": {
    "enabled": true,
    "vault_path": "/absolute/vault",
    "embed_model": { "path": "/absolute/model.gguf", "sha256": "<64 lowercase hex>" },
    "resident": { "url": "http://127.0.0.1:8765", "token_file": "/absolute/token" }
  }
}
```

`expansion_model` and `rerank_model` are optional and must appear together.
Each pin is `{ "path": absolute local file, "sha256": 64 lowercase hex }`.
Unknown keys are `invalid_config`. A vector-only config, with no quality pins
and no `default_mode`, remains valid. Maintenance settings are not semantic
keys; they belong in a separate `qmd-maintenance.json`, which this resident
does not read.

The two command files, model paths, token file, config file, and vault must be absolute local paths.
Archive markers and symlink path components are rejected. The model file must
already exist, match the pinned SHA-256, and start with a GGUF header. This
adapter does not download models and does not change token permissions.

## Requests

Stdin accepts one JSON object: `index`, `search`, `status`, or `embed`.
`embed` is explicit and calls `store.embed` for `one-card-atoms` only.
Vector search, RRF search, and embed require only the embed pin:

```json
{ "semantic": { "embed_model": { "path": "/absolute/model.gguf", "sha256": "<digest>" } } }
```

`full` requires exactly these three local pins and no other semantic keys:

```json
{ "semantic": {
  "embed_model": { "path": "/absolute/embed.gguf", "sha256": "<digest>" },
  "expansion_model": { "path": "/absolute/expand.gguf", "sha256": "<digest>" },
  "rerank_model": { "path": "/absolute/rerank.gguf", "sha256": "<digest>" }
} }
```

Stdin `full` is rejected with `quality_models_missing`. Python calls it over HTTP.
The resident accepts `full` only when startup verified both quality models and
the request pins match those verified files. There is no Hugging Face path, no
default model, and no lexical fallback.

Other actions reject a semantic object. `intent`, `queries`, `rerank`, `expand`,
and `hyde` are rejected on the request. Query operations do not call `embed` or
`update`, do not start the server, and do not fall back from vector, RRF, or
full to lexical.

Missing pieces are errors, not empty success:

| Condition | Code |
| --- | --- |
| No semantic pin on vector, RRF, or embed | `semantic_unconfigured` |
| `full` without both quality pins, or outside the resident | `quality_models_missing` |
| Model file absent | `model_missing` |
| Digest does not match the file or the resident pin | `model_mismatch` |
| File is not a GGUF | `model_invalid` |
| Index has documents without current vectors | `embeddings_missing` |
| Index database absent | `index_missing` |
| Resident process is down | `server_unavailable` |

## Resident server

`bun src/onecard/cli.ts --serve --config ABS` binds `127.0.0.1` at the configured
port. The parent owns the process lifetime and any Windows token ACL.

- `POST /rpc` is the stdin JSON protocol, with `Authorization: Bearer` read from
  `token_file`.
- `GET /health` uses the same authentication.
- Requests that carry an `Origin` header, the wrong or missing token, another
  path, a body over 1 MiB, or a different vault are rejected.
- HTTP allows only `search` and `status`. `index` and `embed` stay stdin actions.
- The process keeps one SDK store and runs requests one at a time. A vector-only
  config opens it with `models.embed`. When both quality pins exist, startup
  verifies all three SHA-256 digests and GGUF headers, then opens the store with
  `models.embed`, `models.generate` (expansion), and `models.rerank`. Bodies,
  queries, tokens, and model paths are not logged.

Health does not load or run the model. A verified pin returns:

```json
{
  "schema_version": 1,
  "status": "ok",
  "vault_path": "/canonical/vault",
  "embed_model_sha256": "<64 lowercase hex>",
  "engine": { "name": "qmd", "version": "2.8.3", "upstream_commit": "86d2365d17fc682e491c2c53d1e4a884aee8682a", "adapter_revision": "onecard-qmd-v2", "mode": "lexical", "remote_model_calls": 0 }
}
```

`vault_path` is the canonical real path of the configured vault. When both
quality models are configured, health also includes:

```json
{ "quality_models": { "expansion_model_sha256": "<64 lowercase hex>", "rerank_model_sha256": "<64 lowercase hex>" } }
```

The key is absent for a vector-only resident. Health still does not load a model.
It repeats the hash and header checks. `default_mode` is not copied into health.

Search responses include `residency` and `latency_ms` for that call only.
`cold` means this call opened the store. `warm` means the resident store was
already open. Those timings are not averaged together.

## SDK calls

- lexical: `store.searchLex`
- vector: `store.searchVector`
- rrf: `store.search` with `queries: [{type:"lex"}, {type:"vec"}]` for the same
  original text and `rerank: false`
- full: `store.search` with the original `query`, `rerank: true`, `collection`,
  `filter`, and `limit`. The adapter does not pass `queries` or `intent`.

Vector, RRF, and full therefore use the SDK's query embedding. `full` uses the
local expansion model only when upstream does not take the strong-BM25 bypass,
and uses the local rerank model when that pipeline reranks. That is not
`store.embed`, not an index update, and not a remote model call. If the index
has no current embeddings, the adapter returns `embeddings_missing` before that
call. Every
semantic mode keeps the current-document allow list.

## Gaps

These are limits of the unchanged SDK, not success states:

- Upstream structured search reads at most 20 hits from each list and gives the
  first list weight 2. Explicit RRF uses that behavior as-is. `full` uses
  `hybridQuery`: a strong BM25 hit can skip expansion, expansion may emit hyde
  queries, and reranking keeps 40 candidates. The returned score is that
  pipeline's blended score. The adapter does not replace it.
- Stdin cannot run `full`. Python sends `mode: "full"` to the resident after
  choosing `default_mode` itself. Native `auto` stays lexical.
- `createStore` can unload a model after five minutes without calls. The
  resident process keeps the store object; it cannot change that timer.
- A GGUF header and SHA-256 are checked locally. A separate private snapshot
  confirmed vector, RRF, and full GGUF inference for three preselected queries.
  That run did not activate production. The queries, model paths, and data are
  not recorded here. A strong BM25 hit can still skip expansion.
- `remote_model_calls` is 0 because this adapter never selects an `hf:` or URL
  model. Traffic was not captured.
- `docs/ONECARD.md` and `skills/onecard` still describe lexical-only use. They
  are outside this change.
