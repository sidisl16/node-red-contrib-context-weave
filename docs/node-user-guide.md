# ContextWeave node user guide

This is the practical manual for building ContextWeave flows in Node-RED. It covers the supported behavior in this release, every node, and every editor option. Internal node type IDs begin with `context-weave-`, but the palette shows the shorter names used below.

## Start here

### The five-part mental model

1. **Connect data.** Use any Node-RED connector you already trust: HTTP, MQTT, SQL, S3, SharePoint, Google Drive, a private node, or an Inject node.
2. **Normalize and index it.** Use `source-map → parse-content → record-ingest → split → index`. For an already-structured document, start at `record-ingest`. For a single file, `file-ingest` is the shortcut.
3. **Retrieve evidence.** Use `retrieve`, then optionally `rerank`, `context`, `filter`, or `format-evidence`.
4. **Generate a grounded answer.** Use `answer` with a generation model profile. Use `generate` only when you intentionally need general model generation.
5. **Keep identity and errors explicit.** Set trusted `msg.auth.tenantId` (and `msg.auth.sub` for conversations), and wire every error output.

### Prerequisites

- Node.js 24.14 or newer and Node-RED 5.0.10 or newer.
- An embedding model for dense or hybrid retrieval. Ollama is the simplest local option.
- A generation model only for `answer`, `generate`, `fact-check`, `document-summarize`, and `agent-run`.
- SQLite works without a separate vector server. Qdrant, pgvector, and Chroma are optional.
- A Tika provider is needed for PDFs and other binary formats. Plain text, Markdown, HTML, and structured records use built-in parsing.

### Read the palette at a glance

Every operational node has an action-specific icon and a color that identifies its job. Colors support scanning; labels and ports remain the source of truth for behavior.

| Color | Family | Meaning | Typical nodes |
| --- | --- | --- | --- |
| Slate (`#607D8B`) | Configuration | Reusable connection, model, library, source, or conversation settings. | `provider`, `model-profile`, `library` |
| Blue-gray (`#78909C`) | Library lifecycle | Create, inspect, update, reset, or delete a library. | `library-create`, `library-info`, `library-delete` |
| Orange (`#F4A261`) | Ingestion | Bring content in, normalize it, split it, or write it to a library. | `source-map`, `split`, `index` |
| Blue (`#5B8DEF`) | Retrieval | Find, rank, filter, expand, or format evidence. | `retrieve`, `rerank`, `filter` |
| Purple (`#A78BFA`) | Generation | Generate, validate, or render grounded model output. | `answer`, `generate`, `cite` |
| Teal (`#2AA198`) | Conversations and agents | Manage conversations and bounded agent actions. | `conversation-turn`, `agent-run` |

Example: the orange **scissors** icon is `split`; the blue **search** icon is `retrieve`; the purple **comment** icon is `answer`; the orange **database** icon is `index`. This makes the usual pipeline easy to read left to right: orange ingestion → blue retrieval → purple answer.

## Understanding libraries

A **library** is ContextWeave’s logical knowledge collection. It binds a stable library ID to one embedding model, an access policy, filterable metadata fields, and an optional external vector database. Documents, chunks, retrieval history, and index compatibility information belong to that library. It is not a folder watcher or source connector: your Node-RED connector supplies the records.

Do not confuse the two related pieces:

- The **`library` configuration node** defines the ID, embedding profile, privacy, access policy, filter schema, and vector backend. Other nodes select this configuration.
- The **library lifecycle nodes** perform actions against it. `library-create` initializes or describes it; `library-info` reports counts; `library-update` makes supported additive metadata changes; `library-reset` removes indexed contents but preserves the logical library; and `library-delete` marks it deleted after explicit confirmation.

### What is stored where

| Library setting | Dense vectors | Documents, chunks and metadata | Keyword index | Sync/history data |
| --- | --- | --- | --- | --- |
| No vector provider | Local SQLite | Local SQLite | Local SQLite FTS5 | Local SQLite |
| Qdrant, pgvector, or Chroma selected | External service, with a local durable vector copy | Local SQLite | Local SQLite FTS5 | Local SQLite |

The SQLite files live under the Node-RED user directory’s `context-weave` storage area. With the default tenant policy, each tenant gets an isolated hashed SQLite file and isolated vector scope. Back up this directory even when dense vectors are external.

### Configure a library step by step

1. Create a provider for the embedding service and a `model-profile` whose purpose is `embedding`.
2. Add a `library` configuration node. Give `libraryId` a stable lowercase machine key such as `support-kb`; do not rename it after indexing.
3. Select the embedding profile. Indexing always creates embeddings, including when you plan to retrieve in lexical mode.
4. Leave `vectorProvider` empty for SQLite. Select a Qdrant, pgvector, or Chroma provider only when you want external dense search.
5. Choose privacy deliberately. `local-only` rejects non-loopback services; an external or commercial endpoint requires a compatible outbound policy.
6. Keep the default tenant-field access policy for multi-tenant data. Supply trusted `msg.auth.tenantId`, and ensure every indexed document has matching `metadata.tenant_id`.
7. Define only metadata fields that must be validated or filtered, for example `[{"name":"status","type":"string","required":true}]`. Supported types are string, boolean, integer, float/number, date, and datetime.
8. Use `library-create` once if you want an explicit initialization receipt, then index documents. Storage is also created lazily on first permitted operation.

### Embedding compatibility and reindexing

A library records the embedding profile identity and the returned vector dimensions. Changing the provider, model, revision, dimensions, or normalization creates an incompatible vector space and indexing fails with a conflict instead of mixing vectors. To change embedding space, create a new library ID and reindex all source documents, validate retrieval, then retire the old library. Changing only the generation model used by `answer` does not require reindexing.

Do not switch an existing library between SQLite and an external vector provider in place. Use a new library ID, allow the source connector to replay its documents, validate counts with `library-info`, and then move retrieval to the new library.

### Access, filters, and multiple libraries

- Access policy is enforced before dense and lexical retrieval. A UI filter is not an authorization boundary.
- `filterAttributes` defines the metadata names and types permitted by the safe filter grammar. Expressions such as `status = "published"` are parameterized; raw SQL and JavaScript are rejected.
- Most operational nodes select one `library`. `retrieve` can use its main library or a JSON `libraries` list for multiple targets. Every selected library still applies its own tenant policy and embedding profile.
- `library-list` only lists explicitly selected/configured libraries; it does not scan arbitrary files on disk.
- Set `allowDestructive` only when reset/delete is operationally required. Keep `dryRun` on first, supply boolean confirmation, and require the exact library ID for deletion.

### First working flow

1. Import [the support RAG example](../examples/support-rag.json).
2. Open the `provider` nodes and verify their URLs. Keep privacy set to `local-only` for local Ollama.
3. Set an embedding model in the embedding `model-profile`, then select that profile in `library`.
4. Set a generation model in the generation `model-profile`, then select it in `answer`.
5. Deploy. Trigger the indexing Inject node once, then trigger the question Inject node.
6. Inspect `msg.contextWeave.evidence`, `msg.contextWeave.answer`, and the error outputs in Debug.

## Choosing configurations

| Need | Select | Important rule |
| --- | --- | --- |
| Local generation or embeddings | Ollama provider + matching model profiles | Keep `baseUrl` on loopback for `local-only`. |
| OpenAI, Claude, or Gemini generation | Provider + generation profile | Choose an outbound privacy policy deliberately; never paste browser-session credentials. |
| Dense search without another service | Blank library `vectorProvider` | SQLite stores vectors locally. |
| External dense search | Qdrant, pgvector, or Chroma provider in the library | SQLite still stores source text, lexical data, and the sync log. |
| PDF or office extraction | Tika provider selected as `extractor` | Choose parser route `remote` or `auto`. |
| A proprietary/private parser | Parser route `custom` | Wire the custom-parser output to your own branch and return a normalized document. |

## Message and output conventions

- Nodes read configured typed values from `msg`, flow context, global context, environment variables, or literals.
- Stable outputs are written below `msg.contextWeave`; the original message continues through the flow.
- `source-map` routes upserts and deletes separately. `parse-content` has a custom-parser branch. Generation nodes have event, complete, and error outputs.
- Error messages are deliberately safe and compact. Inspect `msg.error.code`, `msg.error.requestId`, and `msg.error.retryable`.
- Configuration nodes contain reusable settings and have no ports.
- Blank node-level mapping values may fall back to a selected `source-profile`. Explicit node values override that profile.

## Node reference

- **Configuration nodes:** [`provider`](#provider), [`model-profile`](#model-profile), [`library`](#library), [`source-profile`](#source-profile), [`conversation-store`](#conversation-store)
- **Library lifecycle:** [`library-create`](#library-create), [`library-list`](#library-list), [`library-info`](#library-info), [`library-update`](#library-update), [`library-reset`](#library-reset), [`library-delete`](#library-delete)
- **Ingestion and documents:** [`source-map`](#source-map), [`parse-content`](#parse-content), [`record-ingest`](#record-ingest), [`file-ingest`](#file-ingest), [`split`](#split), [`index`](#index), [`document-get`](#document-get), [`document-list`](#document-list), [`document-patch`](#document-patch), [`document-replace-metadata`](#document-replace-metadata), [`document-delete`](#document-delete), [`document-summarize`](#document-summarize)
- **Retrieval and evidence:** [`retrieve`](#retrieve), [`rerank`](#rerank), [`context`](#context), [`filter`](#filter), [`format-evidence`](#format-evidence), [`query-history`](#query-history)
- **Generation and citations:** [`answer`](#answer), [`generate`](#generate), [`cite`](#cite), [`fact-check`](#fact-check)
- **Conversations and agents:** [`conversation-open`](#conversation-open), [`conversation-turn`](#conversation-turn), [`conversation-read`](#conversation-read), [`conversation-delete`](#conversation-delete), [`agent-run`](#agent-run), [`agent-tool`](#agent-tool)

## Configuration nodes

### `provider`

**Palette:** configuration family · color `#607D8B` · icon `fa-plug`.

Reusable provider configuration.

**How to use it:** Create it from a matching configuration selector, give it a clear name, save it, and reuse it in dependent nodes. It has no wires.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `adapter` | string | `ollama` | `ollama`, `openai`, `openai-compatible`, `anthropic`, `google-gemini`, `huggingface-tei`, `cross-encoder`, `tika`, `qdrant`, `pgvector`, `chroma` | Always | Backend or API protocol used by this connection. |
| `baseUrl` | string | `http://localhost:11434` | See “What it controls”; runtime validation applies. | Always | Service endpoint or PostgreSQL connection URL. |
| `timeoutMs` | number | `60000` | See “What it controls”; runtime validation applies. | Always | Maximum provider request time in milliseconds. |
| `apiKey` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Secret used by the selected service. Node-RED stores it as a credential. |

### `model-profile`

**Palette:** configuration family · color `#607D8B` · icon `fa-microchip`.

Reusable model profile configuration.

**How to use it:** Create it from a matching configuration selector, give it a clear name, save it, and reuse it in dependent nodes. It has no wires.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `provider` | string | _empty_ | Select a **provider** configuration node. | Always | Provider configuration used by this profile. |
| `purpose` | string | `generation` | `generation`, `embedding`, `reranking` | Always | Capability this model profile is allowed to perform. |
| `model` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Exact model identifier expected by the provider. |
| `privacy` | string | `local-only` | `local-only`, `allow-commercial-api`, `commercial-api-with-redaction` | Always | Controls whether content may leave the local host. |
| `temperature` | number | `0.2` | See “What it controls”; runtime validation applies. | When `purpose` is `generation` | Generation randomness; lower values are more deterministic. |
| `maxOutputTokens` | number | `900` | See “What it controls”; runtime validation applies. | When `purpose` is `generation` | Maximum tokens requested from a generation model. |
| `maxContextChars` | number | `24000` | See “What it controls”; runtime validation applies. | When `purpose` is `generation` or `reranking` | Maximum characters admitted to the model context. |
| `batchSize` | number | `32` | See “What it controls”; runtime validation applies. | When `purpose` is `embedding` or `reranking` | Maximum embedding or reranking items in one request. |
| `revision` | string | `1` | See “What it controls”; runtime validation applies. | When `purpose` is `embedding` | Embedding model revision recorded with indexed vectors. |
| `dimensions` | number | `0` | See “What it controls”; runtime validation applies. | When `purpose` is `embedding` | Expected embedding dimensions; zero lets the provider determine it. |
| `topP` | string | _empty_ | See “What it controls”; runtime validation applies. | When `purpose` is `generation` | Optional nucleus-sampling limit. |
| `normalization` | string | `none` | `none`, `l2` | When `purpose` is `embedding` | Vector normalization policy. |
| `fallbackProfiles` | JSON array | `[]` | See “What it controls”; runtime validation applies. | Always | Ordered model-profile IDs tried after a retryable failure. |
| `failInsteadOfFallback` | boolean | `false` | `true` or `false` | Always | Stop instead of sending data to a fallback profile. |

### `library`

**Palette:** configuration family · color `#607D8B` · icon `fa-database`.

Reusable library configuration.

**How to use it:** Create it from a matching configuration selector, give it a clear name, save it, and reuse it in dependent nodes. It has no wires.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `libraryId` | string | `support-kb` | See “What it controls”; runtime validation applies. | Always | Stable machine ID for the library. |
| `embeddingProfile` | string | _empty_ | Select a **model-profile** configuration node. | Always | Embedding model profile used for indexing and dense retrieval. |
| `vectorProvider` | string | _empty_ | Select a **provider** configuration node. | Always | Optional Qdrant, pgvector, or Chroma provider; blank uses SQLite vectors. |
| `privacy` | string | `local-only` | `local-only`, `allow-commercial-api`, `commercial-api-with-redaction` | Always | Controls whether content may leave the local host. |
| `filterAttributes` | JSON array | `[]` | See “What it controls”; runtime validation applies. | Always | Metadata fields that the safe filter grammar may query. |
| `accessPolicy` | JSON object | `{"mode":"tenant-field","metadataField":"tenant_id","claimProperty":"auth.tenantId"}` | See “What it controls”; runtime validation applies. | Always | Tenant access policy JSON applied before retrieval. |
| `allowDestructive` | boolean | `false` | `true` or `false` | Always | Allows reset and deletion operations for this library. |

### `source-profile`

**Palette:** configuration family · color `#607D8B` · icon `fa-exchange`.

Reusable source profile configuration.

**How to use it:** Create it from a matching configuration selector, give it a clear name, save it, and reuse it in dependent nodes. It has no wires.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `sourceSystem` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Stable name for the upstream system. |
| `itemIdSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `itemIdSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `contentSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `contentSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `contentKind` | string | `auto` | `auto`, `record`, `file`, `html`, `markdown`, `text` | Always | How to interpret the mapped content; auto detects common values. |
| `metadataSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `metadataSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `uriSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `uriSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `filenameSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `filenameSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `mimeTypeSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `mimeTypeSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `titleSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `titleSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `modifiedAtSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `modifiedAtSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `checkpointSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `checkpointSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `operation` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Configuration value for operation. |
| `operationType` | selector | `str` | See “What it controls”; runtime validation applies. | Always | Configuration value for operation type. |

### `conversation-store`

**Palette:** configuration family · color `#607D8B` · icon `fa-comments`.

Reusable conversation store configuration.

**How to use it:** Create it from a matching configuration selector, give it a clear name, save it, and reuse it in dependent nodes. It has no wires.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `adapter` | string | `sqlite` | `sqlite`, `memory` | Always | Backend or API protocol used by this connection. |
| `ttlSeconds` | number | `86400` | See “What it controls”; runtime validation applies. | Always | Conversation lifetime after its latest activity. |
| `maxTurns` | number | `20` | See “What it controls”; runtime validation applies. | Always | Maximum retained conversation messages. |
| `maxChars` | number | `24000` | See “What it controls”; runtime validation applies. | Always | Maximum total retained conversation characters. |


## Library lifecycle

### `library-create`

**Palette:** lifecycle family · color `#78909C` · icon `fa-plus-circle`.

Creates storage/index namespaces and persists metadata schema. Idempotency key supported.

**How to use it:** Wire a message containing **optional `msg.contextWeave.librarySpec`** into the node, configure the options below, and read **library descriptor** from the success/complete output. Always wire the error output during development and production.

**Ports:** optional `msg.contextWeave.librarySpec` → library descriptor; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |

### `library-list`

**Palette:** lifecycle family · color `#78909C` · icon `fa-list`.

Lists only libraries allowed by configured server policy.

**How to use it:** Wire a message containing **filters/pagination** into the node, configure the options below, and read **`msg.contextWeave.libraries`** from the success/complete output. Always wire the error output during development and production.

**Ports:** filters/pagination → `msg.contextWeave.libraries`; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `libraries` | JSON array | `[]` | See “What it controls”; runtime validation applies. | Always | Optional JSON list of weighted library targets. |
| `pageSize` | number | `50` | See “What it controls”; runtime validation applies. | Always | Maximum entries returned on one page. |
| `cursorSource` | string | `contextWeave.cursor` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `cursorSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |

### `library-info`

**Palette:** lifecycle family · color `#78909C` · icon `fa-info-circle`.

Returns schema, provider versions, document/chunk counts, last indexing job.

**How to use it:** Wire a message containing **library ID** into the node, configure the options below, and read **descriptor + size/statistics** from the success/complete output. Always wire the error output during development and production.

**Ports:** library ID → descriptor + size/statistics; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |

### `library-update`

**Palette:** lifecycle family · color `#78909C` · icon `fa-pencil`.

Allows name/description/additive schema/default recipes. Rejects unsafe changes without migration flag.

**How to use it:** Wire a message containing **patch object** into the node, configure the options below, and read **updated descriptor** from the success/complete output. Always wire the error output during development and production.

**Ports:** patch object → updated descriptor; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `patchSource` | string | `contextWeave.patch` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `patchSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |

### `library-reset`

**Palette:** lifecycle family · color `#78909C` · icon `fa-refresh`.

Deletes indexed document/chunk data but preserves library config. Use a two-stage editor confirmation and audit event.

**How to use it:** Wire a message containing **library ID + `confirm: true`** into the node, configure the options below, and read **reset report** from the success/complete output. Always wire the error output during development and production.

**Ports:** library ID + `confirm: true` → reset report; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `confirmSource` | string | `contextWeave.confirm` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `confirmSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `dryRun` | boolean | `true` | `true` or `false` | Always | Report the destructive action without applying it. |

### `library-delete`

**Palette:** lifecycle family · color `#78909C` · icon `fa-trash`.

Deletes config and all associated data. Disabled by default in runtime settings.

**How to use it:** Wire a message containing **library ID + `confirm: true`** into the node, configure the options below, and read **deletion receipt** from the success/complete output. Always wire the error output during development and production.

**Ports:** library ID + `confirm: true` → deletion receipt; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `confirmSource` | string | `contextWeave.confirm` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `confirmSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `dryRun` | boolean | `true` | `true` or `false` | Always | Report the destructive action without applying it. |


## Ingestion and documents

### `source-map`

**Palette:** ingest family · color `#F4A261` · icon `fa-exchange`.

Maps arbitrary Node-RED message properties to a stable source/item envelope; does not parse or index.

**How to use it:** Wire a message containing **any connector message** into the node, configure the options below, and read **normalized source envelope** from the success/complete output. Always wire the error output during development and production.

**Ports:** any connector message → normalized source envelope; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `sourceProfile` | string | _empty_ | Select a **source-profile** configuration node. | Always | Reusable connector mapping; non-empty fields on this node override it. |
| `sourceSystem` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Stable name for the upstream system. |
| `itemIdSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `itemIdSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `contentSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `contentSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `contentKind` | string | `auto` | `auto`, `record`, `file`, `html`, `markdown`, `text` | Always | How to interpret the mapped content; auto detects common values. |
| `metadataSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `metadataSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `uriSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `uriSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `filenameSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `filenameSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `mimeTypeSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `mimeTypeSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `titleSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `titleSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `modifiedAtSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `modifiedAtSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `checkpointSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `checkpointSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `operation` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Configuration value for operation. |
| `operationType` | selector | `str` | See “What it controls”; runtime validation applies. | Always | Configuration value for operation type. |

### `parse-content`

**Palette:** ingest family · color `#F4A261` · icon `fa-file-text-o`.

Extracts text, tables, page/section locators, and parser warnings through the chosen parser route.

**How to use it:** Wire a message containing **normalized source envelope containing a file, HTML, Markdown, or text** into the node, configure the options below, and read **parsed document/sections** from the success/complete output. Always wire the error output during development and production.

**Ports:** normalized source envelope containing a file, HTML, Markdown, or text → parsed document/sections; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `parserRoute` | string | `auto` | `auto`, `built-in`, `remote`, `custom` | Always | Parser selection: automatic, built-in text, remote Tika, or a custom branch. |
| `extractor` | string | _empty_ | Select a **provider** configuration node. | When `parserRoute` is `auto` or `remote` | Tika provider used for remote extraction. |
| `maxFileMb` | number | `10` | See “What it controls”; runtime validation applies. | Always | Maximum accepted source file size in MiB. |
| `timeoutSeconds` | number | `60` | See “What it controls”; runtime validation applies. | When `parserRoute` is `auto` or `remote` | Maximum extraction or agent duration in seconds. |
| `sourceEnvelope` | string | `contextWeave.source` | See “What it controls”; runtime validation applies. | Always | Property containing the normalized source envelope. |
| `sourceEnvelopeType` | selector | `msg` | See “What it controls”; runtime validation applies. | Always | Configuration value for source envelope type. |
| `outputProperty` | string | `contextWeave.input.document` | See “What it controls”; runtime validation applies. | Always | Message property where this node writes its main result. |

### `record-ingest`

**Palette:** ingest family · color `#F4A261` · icon `fa-sign-in`.

Normalizes structured source. Use when caller controls document/section boundaries.

**How to use it:** Wire a message containing **`msg.payload` or `msg.contextWeave.input.document` matching `DocumentInput`** into the node, configure the options below, and read **indexed document report** from the success/complete output. Always wire the error output during development and production.

**Ports:** `msg.payload` or `msg.contextWeave.input.document` matching `DocumentInput` → indexed document report; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `documentSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `documentSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `idPath` | string | `id` | See “What it controls”; runtime validation applies. | Always | Path to the record document ID. |
| `titlePath` | string | `title` | See “What it controls”; runtime validation applies. | Always | Path to the optional record title. |
| `textPath` | string | `text` | See “What it controls”; runtime validation applies. | Always | Path to the record text. |
| `metadataPath` | string | `metadata` | See “What it controls”; runtime validation applies. | Always | Path to the record metadata object. |

### `file-ingest`

**Palette:** ingest family · color `#F4A261` · icon `fa-file-o`.

Extracts text/tables where adapter supports it, preserves supplied metadata, then submits to pipeline. Enforce configurable file/parse-time limits.

**How to use it:** Wire a message containing **`msg.payload` Buffer/path (if runtime permits) or `{data, filename, mimeType}`** into the node, configure the options below, and read **indexed document report** from the success/complete output. Always wire the error output during development and production.

**Ports:** `msg.payload` Buffer/path (if runtime permits) or `{data, filename, mimeType}` → indexed document report; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `parserRoute` | string | `auto` | `auto`, `built-in`, `remote` | Always | Parser selection: automatic, built-in text, remote Tika, or a custom branch. |
| `extractor` | string | _empty_ | Select a **provider** configuration node. | When `parserRoute` is `auto` or `remote` | Tika provider used for remote extraction. |
| `maxFileMb` | number | `10` | See “What it controls”; runtime validation applies. | Always | Maximum accepted source file size in MiB. |
| `timeoutSeconds` | number | `60` | See “What it controls”; runtime validation applies. | When `parserRoute` is `auto` or `remote` | Maximum extraction or agent duration in seconds. |
| `fileSource` | string | `payload` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `fileSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `documentIdSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `documentIdSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `metadataSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `metadataSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `filenameSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `filenameSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `mimeTypeSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `mimeTypeSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |

### `split`

**Palette:** ingest family · color `#F4A261` · icon `fa-scissors`.

Deterministic splitter. Modes: sentence-window, token-window, paragraph, section, markdown headings, custom regex. Never span a section boundary by default. Persist splitter version/config.

**How to use it:** Wire a message containing **normalized document** into the node, configure the options below, and read **document plus chunks** from the success/complete output. Always wire the error output during development and production.

**Ports:** normalized document → document plus chunks; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `documentSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `documentSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `strategy` | string | `sentence-window` | `sentence-window`, `token-window`, `paragraph`, `section`, `markdown-headings`, `custom-regex` | Always | Algorithm used by this node. |
| `targetTokens` | number | `800` | See “What it controls”; runtime validation applies. | Always | Approximate target chunk size. |
| `overlapTokens` | number | `120` | See “What it controls”; runtime validation applies. | Always | Approximate overlap between adjacent chunks. |
| `customRegex` | string | _empty_ | See “What it controls”; runtime validation applies. | When `strategy` is `custom-regex` | Regular expression used as a chunk boundary. |
| `outputProperty` | string | `contextWeave.input.chunks` | See “What it controls”; runtime validation applies. | Always | Message property where this node writes its main result. |

### `index`

**Palette:** ingest family · color `#F4A261` · icon `fa-database`.

Upserts vectors + lexical entries atomically as far as adapter permits. Idempotent by document ID + content hash.

**How to use it:** Wire a message containing **document/chunks** into the node, configure the options below, and read **`{documentId, chunksCreated, chunksUpdated, chunksDeleted}`** from the success/complete output. Always wire the error output during development and production.

**Ports:** document/chunks → `{documentId, chunksCreated, chunksUpdated, chunksDeleted}`; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `mode` | string | `upsert` | `upsert`, `create-only` | Always | Operation or retrieval mode. |
| `documentSource` | string | `contextWeave.input.document` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `documentSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `chunksSource` | string | `contextWeave.input.chunks` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `chunksSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |

### `document-get`

**Palette:** ingest family · color `#F4A261` · icon `fa-file-text-o`.

Retrieves source metadata and chunks only when policy allows it.

**How to use it:** Wire a message containing **document ID** into the node, configure the options below, and read **complete stored document** from the success/complete output. Always wire the error output during development and production.

**Ports:** document ID → complete stored document; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `documentIdSource` | string | `contextWeave.documentId` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `documentIdSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `includeChunks` | boolean | `false` | `true` or `false` | Always | Include stored chunks with the returned document. |

### `document-list`

**Palette:** ingest family · color `#F4A261` · icon `fa-list`.

Returns no chunk text by default.

**How to use it:** Wire a message containing **filter/page** into the node, configure the options below, and read **document summaries** from the success/complete output. Always wire the error output during development and production.

**Ports:** filter/page → document summaries; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `pageSize` | number | `50` | See “What it controls”; runtime validation applies. | Always | Maximum entries returned on one page. |
| `cursorSource` | string | `contextWeave.cursor` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `cursorSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `metadataFilter` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Safe metadata filter expression; raw SQL or JavaScript is never evaluated. |

### `document-patch`

**Palette:** ingest family · color `#F4A261` · icon `fa-pencil`.

Merges metadata, reindexes filter fields only if needed.

**How to use it:** Wire a message containing **document ID + metadata patch** into the node, configure the options below, and read **updated descriptor** from the success/complete output. Always wire the error output during development and production.

**Ports:** document ID + metadata patch → updated descriptor; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `documentIdSource` | string | `contextWeave.documentId` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `documentIdSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `metadataSource` | string | `contextWeave.patch` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `metadataSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |

### `document-replace-metadata`

**Palette:** ingest family · color `#F4A261` · icon `fa-tags`.

Replaces metadata exactly.

**How to use it:** Wire a message containing **document ID + full metadata** into the node, configure the options below, and read **updated descriptor** from the success/complete output. Always wire the error output during development and production.

**Ports:** document ID + full metadata → updated descriptor; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `documentIdSource` | string | `contextWeave.documentId` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `documentIdSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `metadataSource` | string | `contextWeave.metadata` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `metadataSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |

### `document-delete`

**Palette:** ingest family · color `#F4A261` · icon `fa-trash`.

Removes vectors, lexical entries, chunk rows, and source metadata.

**How to use it:** Wire a message containing **document ID + `confirm`** into the node, configure the options below, and read **receipt** from the success/complete output. Always wire the error output during development and production.

**Ports:** document ID + `confirm` → receipt; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `documentIdSource` | string | `contextWeave.documentId` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `documentIdSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `confirmSource` | string | `contextWeave.confirm` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `confirmSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `dryRun` | boolean | `true` | `true` or `false` | Always | Report the destructive action without applying it. |

### `document-summarize`

**Palette:** generation family · color `#A78BFA` · icon `fa-compress`.

Uses a generation provider with explicit template/model/limits. Supports normal and stream outputs.

**How to use it:** Wire a message containing **document ID or normalized document** into the node, configure the options below, and read **`msg.contextWeave.summary` + trace** from the success/complete output. Always wire the error output during development and production.

**Ports:** document ID or normalized document → `msg.contextWeave.summary` + trace; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `generationProfile` | string | _empty_ | Select a **model-profile** configuration node. | Always | Generation model profile used by this node. |
| `streamMode` | string | `off` | `off`, `events`, `tokens` | Always | Whether progress is emitted on the event output. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `documentIdSource` | string | `contextWeave.documentId` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `instructions` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Additional trusted instructions appended to the built-in prompt. |


## Retrieval and evidence

### `retrieve`

**Palette:** retrieval family · color `#5B8DEF` · icon `fa-search`.

Dense, lexical, or hybrid retrieval across one/many libraries. No LLM call.

**How to use it:** Wire a message containing **`msg.contextWeave.query` (or configured property)** into the node, configure the options below, and read **`msg.contextWeave.evidence`** from the success/complete output. Always wire the error output during development and production.

**Ports:** `msg.contextWeave.query` (or configured property) → `msg.contextWeave.evidence`; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `libraries` | JSON array | `[]` | See “What it controls”; runtime validation applies. | Always | Optional JSON list of weighted library targets. |
| `querySource` | string | `contextWeave.query` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `querySourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `mode` | string | `hybrid` | `hybrid`, `dense`, `lexical` | Always | Operation or retrieval mode. |
| `lexicalWeight` | number | `0.05` | See “What it controls”; runtime validation applies. | When `mode` is `hybrid` | Hybrid-search weight from 0 (dense) to 1 (lexical). |
| `metadataFilter` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Safe metadata filter expression; raw SQL or JavaScript is never evaluated. |
| `candidateLimit` | number | `25` | See “What it controls”; runtime validation applies. | Always | Candidates fetched before final limiting or reranking. |
| `resultLimit` | number | `10` | See “What it controls”; runtime validation applies. | Always | Maximum retrieval results. |
| `offset` | number | `0` | See “What it controls”; runtime validation applies. | Always | Number of ranked results to skip. |
| `contextMode` | string | `sentences` | `sentences`, `characters`, `none` | Always | Adds sentence context, character context, or no surrounding context. |
| `sentencesBefore` | number | `1` | See “What it controls”; runtime validation applies. | When `contextMode` is `sentences` | Sentences added before each matching chunk. |
| `sentencesAfter` | number | `1` | See “What it controls”; runtime validation applies. | When `contextMode` is `sentences` | Sentences added after each matching chunk. |
| `charactersBefore` | number | `100` | See “What it controls”; runtime validation applies. | When `contextMode` is `characters` | Characters added before each matching chunk. |
| `charactersAfter` | number | `100` | See “What it controls”; runtime validation applies. | When `contextMode` is `characters` | Characters added after each matching chunk. |
| `highlights` | boolean | `false` | `true` or `false` | Always | Include query-term character ranges. |

### `rerank`

**Palette:** retrieval family · color `#5B8DEF` · icon `fa-sort-amount-desc`.

Applies one strategy or ordered strategy chain. Preserve prior scores.

**How to use it:** Wire a message containing **query + evidence** into the node, configure the options below, and read **reordered evidence** from the success/complete output. Always wire the error output during development and production.

**Ports:** query + evidence → reordered evidence; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `querySource` | string | `contextWeave.query` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `querySourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `evidenceSource` | string | `contextWeave.evidence` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `evidenceSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `strategy` | string | `mmr` | `none`, `cross-encoder`, `mmr`, `rule`, `chain` | Always | Algorithm used by this node. |
| `stages` | JSON array | `[]` | See “What it controls”; runtime validation applies. | When `strategy` is `chain` | Ordered JSON reranking stages used by chain mode. |
| `rerankProfile` | string | _empty_ | Select a **model-profile** configuration node. | When `strategy` is `cross-encoder` | Reranking model profile used by the cross-encoder strategy. |
| `diversityBias` | number | `0.3` | See “What it controls”; runtime validation applies. | When `strategy` is `mmr` | MMR diversity preference from 0 to 1. |
| `limit` | number | `10` | See “What it controls”; runtime validation applies. | Always | Maximum evidence items retained. |
| `cutoff` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional minimum reranking score. |
| `field` | string | _empty_ | See “What it controls”; runtime validation applies. | When `strategy` is `rule` | Trusted numeric metadata field used for a rule boost. |
| `boost` | number | `1` | See “What it controls”; runtime validation applies. | When `strategy` is `rule` | Multiplier applied to the rule field. |

### `context`

**Palette:** retrieval family · color `#5B8DEF` · icon `fa-expand`.

Adds surrounding text and/or highlight ranges. Cannot request sentence and character windows together.

**How to use it:** Wire a message containing **evidence** into the node, configure the options below, and read **enriched evidence** from the success/complete output. Always wire the error output during development and production.

**Ports:** evidence → enriched evidence; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `evidenceSource` | string | `contextWeave.evidence` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `evidenceSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `contextMode` | string | `sentences` | `sentences`, `characters`, `none` | Always | Adds sentence context, character context, or no surrounding context. |
| `sentencesBefore` | number | `1` | See “What it controls”; runtime validation applies. | When `contextMode` is `sentences` | Sentences added before each matching chunk. |
| `sentencesAfter` | number | `1` | See “What it controls”; runtime validation applies. | When `contextMode` is `sentences` | Sentences added after each matching chunk. |
| `charactersBefore` | number | `100` | See “What it controls”; runtime validation applies. | When `contextMode` is `characters` | Characters added before each matching chunk. |
| `charactersAfter` | number | `100` | See “What it controls”; runtime validation applies. | When `contextMode` is `characters` | Characters added after each matching chunk. |

### `filter`

**Palette:** retrieval family · color `#5B8DEF` · icon `fa-filter`.

Applies post-retrieval policy/business filter. Security filters must instead be applied before retrieval.

**How to use it:** Wire a message containing **evidence + filter** into the node, configure the options below, and read **filtered evidence** from the success/complete output. Always wire the error output during development and production.

**Ports:** evidence + filter → filtered evidence; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `evidenceSource` | string | `contextWeave.evidence` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `evidenceSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `metadataFilter` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Safe metadata filter expression; raw SQL or JavaScript is never evaluated. |

### `format-evidence`

**Palette:** retrieval family · color `#5B8DEF` · icon `fa-align-left`.

Stable citation tokens such as `[E:abc123]`; keep full evidence separately.

**How to use it:** Wire a message containing **evidence** into the node, configure the options below, and read **text/JSON/Markdown prompt block** from the success/complete output. Always wire the error output during development and production.

**Ports:** evidence → text/JSON/Markdown prompt block; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `evidenceSource` | string | `contextWeave.evidence` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `evidenceSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |
| `format` | string | `text` | `text`, `markdown`, `json` | Always | Output serialization format. |
| `maxItemChars` | number | `4000` | See “What it controls”; runtime validation applies. | Always | Maximum characters copied from one evidence item. |
| `maxTotalChars` | number | `24000` | See “What it controls”; runtime validation applies. | Always | Total formatted evidence character budget. |

### `query-history`

**Palette:** retrieval family · color `#5B8DEF` · icon `fa-history`.

Optional, local-only observability. Redact prompts/content unless explicitly enabled.

**How to use it:** Wire a message containing **request/document/query filters** into the node, configure the options below, and read **historical traces** from the success/complete output. Always wire the error output during development and production.

**Ports:** request/document/query filters → historical traces; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `pageSize` | number | `50` | See “What it controls”; runtime validation applies. | Always | Maximum entries returned on one page. |
| `cursorSource` | string | `contextWeave.cursor` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `cursorSourceType` | selector | `msg` | `msg`, `str`, `flow`, `global`, `env`, `bool`, `num`, `json` | Always | Node-RED typed-input kind used to evaluate the adjacent source value. |


## Generation and citations

### `answer`

**Palette:** generation family · color `#A78BFA` · icon `fa-comment`.

Grounded answer from evidence only by default. Combines retrieve+rerank only when “retrieve automatically” is enabled.

**How to use it:** Wire a message containing **query + evidence** into the node, configure the options below, and read **answer, citations, trace** from the success/complete output. Always wire the error output during development and production.

**Ports:** query + evidence → answer, citations, trace; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `generationProfile` | string | _empty_ | Select a **model-profile** configuration node. | Always | Generation model profile used by this node. |
| `streamMode` | string | `off` | `off`, `events`, `tokens` | Always | Whether progress is emitted on the event output. |
| `evidenceSource` | string | `contextWeave.evidence` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `maxEvidenceChunks` | number | `8` | See “What it controls”; runtime validation applies. | Always | Maximum evidence chunks sent to a model. |
| `maxEvidenceChars` | number | `24000` | See “What it controls”; runtime validation applies. | Always | Maximum total evidence characters sent to a model. |
| `querySource` | string | `contextWeave.query` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `instructions` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Additional trusted instructions appended to the built-in prompt. |
| `requireCitations` | boolean | `true` | `true` or `false` | Always | Reject an evidence-backed answer without valid citations. |
| `minimumCitations` | number | `1` | See “What it controls”; runtime validation applies. | When `requireCitations` is enabled | Minimum valid evidence citations required. |
| `citationFormat` | string | `structured-and-numeric` | `structured-and-numeric`, `markdown`, `html` | Always | How validated citation markers are rendered. |
| `noEvidenceText` | string | `I could not find evidence to answer this question.` | See “What it controls”; runtime validation applies. | Always | Safe response returned when retrieval produces no evidence. |
| `autoRetrieve` | boolean | `false` | `true` or `false` | Always | Run retrieval inside the answer node before generation. |
| `retrievalRecipe` | JSON object | `{}` | See “What it controls”; runtime validation applies. | When `autoRetrieve` is enabled | JSON options passed to the internal retrieve operation. |

### `generate`

**Palette:** generation family · color `#A78BFA` · icon `fa-magic`.

General LLM node; must mark result as ungrounded if no evidence was used.

**How to use it:** Wire a message containing **explicit messages/template + optional evidence** into the node, configure the options below, and read **model response + trace** from the success/complete output. Always wire the error output during development and production.

**Ports:** explicit messages/template + optional evidence → model response + trace; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `generationProfile` | string | _empty_ | Select a **model-profile** configuration node. | Always | Generation model profile used by this node. |
| `streamMode` | string | `off` | `off`, `events`, `tokens` | Always | Whether progress is emitted on the event output. |
| `evidenceSource` | string | `contextWeave.evidence` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `maxEvidenceChunks` | number | `8` | See “What it controls”; runtime validation applies. | Always | Maximum evidence chunks sent to a model. |
| `maxEvidenceChars` | number | `24000` | See “What it controls”; runtime validation applies. | Always | Maximum total evidence characters sent to a model. |
| `messagesSource` | string | `payload` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |

### `cite`

**Palette:** generation family · color `#A78BFA` · icon `fa-quote-right`.

Validates/normalizes citations and can render `numeric`, `markdown`, or `html` forms.

**How to use it:** Wire a message containing **answer with `[E:id]` markers + evidence** into the node, configure the options below, and read **normalized citation list/rendering** from the success/complete output. Always wire the error output during development and production.

**Ports:** answer with `[E:id]` markers + evidence → normalized citation list/rendering; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `answerSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `evidenceSource` | string | `contextWeave.evidence` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `citationFormat` | string | `structured-and-numeric` | `structured-and-numeric`, `markdown`, `html` | Always | How validated citation markers are rendered. |
| `requireCitations` | boolean | `true` | `true` or `false` | Always | Reject an evidence-backed answer without valid citations. |
| `minimumCitations` | number | `1` | See “What it controls”; runtime validation applies. | When `requireCitations` is enabled | Minimum valid evidence citations required. |

### `fact-check`

**Palette:** generation family · color `#A78BFA` · icon `fa-check-circle`.

Optional second-pass entailment/provider check. Never call a generated score “truth”.

**How to use it:** Wire a message containing **answer + evidence** into the node, configure the options below, and read **support assessment** from the success/complete output. Always wire the error output during development and production.

**Ports:** answer + evidence → support assessment; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `generationProfile` | string | _empty_ | Select a **model-profile** configuration node. | Always | Generation model profile used by this node. |
| `evidenceSource` | string | `contextWeave.evidence` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `maxEvidenceChunks` | number | `8` | See “What it controls”; runtime validation applies. | Always | Maximum evidence chunks sent to a model. |
| `maxEvidenceChars` | number | `24000` | See “What it controls”; runtime validation applies. | Always | Maximum total evidence characters sent to a model. |


## Conversations and agents

### `conversation-open`

**Palette:** conversation family · color `#2AA198` · icon `fa-comments`.

Creates or resumes state. Enforce TTL and principal/tenant binding.

**How to use it:** Wire a message containing **optional session key/metadata** into the node, configure the options below, and read **conversation descriptor** from the success/complete output. Always wire the error output during development and production.

**Ports:** optional session key/metadata → conversation descriptor; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `store` | string | _empty_ | Select a **conversation-store** configuration node. | Always | Configuration value for store. |
| `idSource` | string | `contextWeave.conversation.id` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |

### `conversation-turn`

**Palette:** conversation family · color `#2AA198` · icon `fa-paper-plane`.

Persists user/assistant turn only after model validation succeeds.

**How to use it:** Wire a message containing **conversation + user message** into the node, configure the options below, and read **appended turn** from the success/complete output. Always wire the error output during development and production.

**Ports:** conversation + user message → appended turn; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `store` | string | _empty_ | Select a **conversation-store** configuration node. | Always | Configuration value for store. |
| `idSource` | string | `contextWeave.conversation.id` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `textSource` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `role` | string | `user` | `user`, `assistant` | Always | Conversation turn role. |

### `conversation-read`

**Palette:** conversation family · color `#2AA198` · icon `fa-book`.

Returns policy-permitted turns only.

**How to use it:** Wire a message containing **ID** into the node, configure the options below, and read **bounded history** from the success/complete output. Always wire the error output during development and production.

**Ports:** ID → bounded history; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `store` | string | _empty_ | Select a **conversation-store** configuration node. | Always | Configuration value for store. |
| `idSource` | string | `contextWeave.conversation.id` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |

### `conversation-delete`

**Palette:** conversation family · color `#2AA198` · icon `fa-trash`.

Permanently removes conversation memory.

**How to use it:** Wire a message containing **ID + confirm** into the node, configure the options below, and read **receipt** from the success/complete output. Always wire the error output during development and production.

**Ports:** ID + confirm → receipt; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `store` | string | _empty_ | Select a **conversation-store** configuration node. | Always | Configuration value for store. |
| `idSource` | string | `contextWeave.conversation.id` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `confirmSource` | string | `contextWeave.confirm` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `dryRun` | boolean | `true` | `true` or `false` | Always | Report the destructive action without applying it. |

### `agent-run`

**Palette:** conversation family · color `#2AA198` · icon `fa-bolt`.

Executes a bounded tool loop with approved `ContextWeave` retrieval tools and explicit HTTP tools.

**How to use it:** Wire a message containing **user input + tool config** into the node, configure the options below, and read **answer, events, trace** from the success/complete output. Always wire the error output during development and production.

**Ports:** user input + tool config → answer, events, trace; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `generationProfile` | string | _empty_ | Select a **model-profile** configuration node. | Always | Generation model profile used by this node. |
| `streamMode` | string | `off` | `off`, `events`, `tokens` | Always | Whether progress is emitted on the event output. |
| `querySource` | string | `contextWeave.query` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `store` | string | _empty_ | Select a **conversation-store** configuration node. | Always | Configuration value for store. |
| `library` | string | _empty_ | Select a **library** configuration node. | Always | Library configuration used by this operation. |
| `tools` | JSON array | `[]` | See “What it controls”; runtime validation applies. | Always | JSON array of agent tool contracts and retrieval recipes. |
| `maxToolCalls` | number | `5` | See “What it controls”; runtime validation applies. | Always | Maximum tool calls allowed for one agent run. |
| `timeoutSeconds` | number | `60` | See “What it controls”; runtime validation applies. | Always | Maximum extraction or agent duration in seconds. |
| `instructions` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Additional trusted instructions appended to the built-in prompt. |
| `requireCitations` | boolean | `true` | `true` or `false` | Always | Reject an evidence-backed answer without valid citations. |
| `evidenceSource` | string | `contextWeave.evidence` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |
| `maxEvidenceChunks` | number | `8` | See “What it controls”; runtime validation applies. | Always | Maximum evidence chunks sent to a model. |
| `maxEvidenceChars` | number | `24000` | See “What it controls”; runtime validation applies. | Always | Maximum total evidence characters sent to a model. |

### `agent-tool`

**Palette:** conversation family · color `#2AA198` · icon `fa-wrench`.

Adapter node for a user-provided, schema-validated Node-RED branch.

**How to use it:** Wire a message containing **tool call event** into the node, configure the options below, and read **tool result** from the success/complete output. Always wire the error output during development and production.

**Ports:** tool call event → tool result; failures use the error output.

| Option | Type | Default | Allowed values / selection | Shown when | What it controls |
| --- | --- | --- | --- | --- | --- |
| `name` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Optional label shown on the flow. |
| `toolId` | string | _empty_ | See “What it controls”; runtime validation applies. | Always | Allowlisted tool name expected by this bridge. |
| `resultSource` | string | `payload` | See “What it controls”; runtime validation applies. | Always | Message path or typed value read at runtime. |

## Common recipes

### Use your own connector

Wire the connector into `source-map`. Map a stable source system, stable item ID, content, metadata, and optional filename/MIME type. The connector continues to own authentication, polling, pagination, and checkpoints. Route upserts through parsing and indexing; route deletes to `document-delete` with an explicit confirmation policy.

### Choose dense, lexical, or hybrid retrieval

- **Dense** needs an embedding profile and is useful for semantic similarity.
- **Lexical** uses SQLite full-text search and needs no model call.
- **Hybrid** combines both. `lexicalWeight` is only shown for this mode; start with the default `0.05` and measure on representative questions.

### Use a commercial model safely

Create a provider and generation model profile, choose `allow-commercial-api` or `commercial-api-with-redaction`, and confirm that the library policy permits the transfer. ContextWeave sends the selected evidence and prompt to the provider. Never put API keys in Inject nodes, function code, flow JSON, or `msg`; use the provider credential field.

### Delete data safely

Keep `dryRun` enabled first. Supply boolean `true` at the configured confirmation source and verify the selected tenant/library/document. Library reset, library delete, document delete, and conversation delete are intentionally explicit.

## Production checklist

- Authenticate upstream and derive `msg.auth` from a trusted identity, not user-supplied JSON.
- Configure tenant access policy and filter attributes before indexing production data.
- Wire and monitor every error output; retain request IDs without logging secrets or full sensitive content.
- Use stable document IDs so retries are idempotent.
- Pin model names and embedding revisions. Reindex into a new library when embedding dimensions or model space changes.
- Back up the Node-RED user directory and SQLite files consistently, even when using an external vector database.
- Keep `memory` conversation storage for development only; use SQLite for durable bounded sessions.
- Test retrieval quality, filters, citations, and deletion in a staging flow before publishing.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| “Select a compatible model profile” | The node needs the right profile purpose: embedding, generation, or reranking, and the profile needs a model ID. |
| Dense or hybrid retrieval fails | Select an embedding profile in the library and index documents with the same embedding model/revision. |
| A PDF says extraction is unsupported | Configure a Tika provider and use parser route `remote` or `auto`, or use the custom branch. |
| No results | Verify tenant identity, metadata filter, library selection, indexed document count, and query property. Try lexical mode to isolate embedding issues. |
| Citation validation fails | The model must return exact `[E:evidenceId]` markers from the supplied evidence; confirm evidence reached the answer node. |
| Conversation is unavailable | Supply both trusted tenant and principal identity and use the same conversation ID before TTL expiry. |
| External vector search is empty | Check the provider URL/credential, library privacy, vector dimensions, and the synchronization error output/log. |
| Destructive operation is rejected | Enable the library policy where applicable, supply boolean confirmation, and disable `dryRun` only after reviewing the target. |

For architecture and security rationale, see the [design blueprint](design.md). For release boundaries, see [implementation scope](implementation.md).

