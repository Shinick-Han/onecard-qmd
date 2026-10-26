# One Card semantic protocol

Lexical retrieval remains the default. This adapter adds explicit `vector` and `rrf`
modes and a loopback resident process. It does not rewrite queries, expand them,
or call the reranker. Upstream search, indexing, and model code are unchanged.
The upstream pin remains `86d2365d17fc682e491c2c53d1e4a884aee8682a`.

`schema_version` remains `1`. Successful engines use:

- `adapter_revision`: `onecard-qmd-v2`
- `mode`: the mode actually used, `lexical`, `vector`, or `rrf`
- `remote_model_calls`: `0`

`mode: "auto"` is legacy and stays lexical. `mode: "hybrid"` is rejected with
`mode_unavailable`. RRF is lex plus vector fusion of the original query only.
It is not QMD's full hybrid pipeline.

Scores are the SDK's native relevance values. They are not truth or confidence.
Every mode keeps the current-document allow list, collection identity check,
LF-normalized source SHA-256, and indexed `card_version` / `source_version`.
`review_status` is copied through as `indexed_review_status` when it is a string.
Unreviewed documents are not dropped.

## Runtime config

`schema_version`, `upstream_commit`, and `command` are required. `command` is
validated and not executed. Semantic config is optional for stdin lexical use
and required for `--serve`:

```json
{
  "schema_version": 1,
  "upstream_commit": "86d2365d17fc682e491c2c53d1e4a884aee8682a",
  "command": "onecard-qmd",
  "semantic": {
    "enabled": true,
    "vault_path": "/absolute/vault",
    "embed_model": { "path": "/absolute/model.gguf", "sha256": "<64 lowercase hex>" },
    "resident": { "url": "http://127.0.0.1:8765", "token_file": "/absolute/token" }
  }
}
```

The model path, token file, config file, and vault must be absolute local paths.
Archive markers and symlink path components are rejected. The model file must
already exist, match the pinned SHA-256, and start with a GGUF header. This
adapter does not download models and does not change token permissions.

## Requests

Stdin accepts one JSON object: `index`, `search`, `status`, or `embed`.
`embed` is explicit and calls `store.embed` for `one-card-atoms` only.
Vector search, RRF search, and embed require:

```json
{ "semantic": { "embed_model": { "path": "/absolute/model.gguf", "sha256": "<digest>" } } }
```

Other actions reject that object. `intent`, `queries`, `rerank`, `expand`, and
`hyde` are rejected. Query operations do not call `embed` or `update`, do not
start the server, and do not fall back from vector or RRF to lexical.

Missing pieces are errors, not empty success:

| Condition | Code |
| --- | --- |
| No semantic pin on vector, RRF, or embed | `semantic_unconfigured` |
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
- The process keeps one SDK store, opened with the pinned embed model, and runs
  requests one at a time. The model file is checked against the pin. Bodies,
  queries, and tokens are not logged.

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

`vault_path` is the canonical real path of the configured vault.

Search responses include `residency` and `latency_ms` for that call only.
`cold` means this call opened the store. `warm` means the resident store was
already open. Those timings are not averaged together.

## SDK calls

- lexical: `store.searchLex`
- vector: `store.searchVector`
- rrf: `store.search` with `queries: [{type:"lex"}, {type:"vec"}]` for the same
  original text and `rerank: false`

Vector and RRF therefore embed the query text inside the SDK. That is not
`store.embed`, not an index update, and not a remote model call. If the index
has no current embeddings, the adapter returns `embeddings_missing` before that
call.

## Gaps

These are limits of the unchanged SDK, not success states:

- Upstream structured search reads at most 20 hits from each list and gives the
  first list weight 2. RRF uses that behavior as-is.
- `createStore` can unload a model after five minutes without calls. The
  resident process keeps the store object; it cannot change that timer.
- A GGUF header is checked locally. Loading that file and producing vectors was
  not run, so inference quality is unverified.
- `remote_model_calls` is 0 because this adapter never selects an `hf:` or URL
  model. Traffic was not captured.
- `docs/ONECARD.md` and `skills/onecard` still describe lexical-only use. They
  are outside this change.
