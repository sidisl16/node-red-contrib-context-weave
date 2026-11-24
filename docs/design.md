# ContextWeave for Node-RED — implementation blueprint

**Status:** implementation specification for an independent, open-source Node-RED package
**Suggested package:** `node-red-contrib-context-weave`
**Suggested palette category:** `context weave`
**License:** Apache-2.0 (recommended)
**Last researched:** 24 November 2026

## 1. Purpose and non-goals

`ContextWeave` is a provider-neutral RAG and agent-workflow toolkit for Node-RED. It lets a flow ingest files or structured records, retrieve grounded context, optionally rerank it, generate an answer with traceable citations, and maintain bounded conversation state.

Ingestion is **connector-first**: ContextWeave does not require a proprietary connector marketplace. A user may connect any Node-RED source node — for example HTTP, MQTT, S3, Google Drive, SharePoint, SQL, CRM, helpdesk, Git, RSS, or a custom community/private node — to ContextWeave’s source-mapping and parsing nodes. ContextWeave standardizes the data *after* the user’s connector has emitted a message.

It should reproduce the *capabilities and workflow model* of a modern enterprise RAG platform, not copy Vectara source code, UI, schemas, names, presets, documentation wording, or hosted service. Rename concepts, design fresh message contracts, and implement against independently selected backends. Do not claim Vectara compatibility.

The first release should work completely with local/self-hosted components:

- Vector store: Qdrant, pgvector, Chroma, or an in-memory test adapter.
- Lexical index: optional SQLite FTS5, Meilisearch, Elasticsearch/OpenSearch, or backend-native BM25.
- Embeddings: OpenAI-compatible endpoint, Ollama, Hugging Face inference, or a custom HTTP adapter.
- Chat/generation: OpenAI-compatible endpoint, Ollama, Anthropic adapter, or a custom HTTP adapter.
- Reranking: cross-encoder HTTP adapter, a local model adapter, MMR, and deterministic JavaScript rules.
- File extraction: Apache Tika sidecar, Unstructured-compatible endpoint, or built-in plain-text/Markdown/HTML parsers.

It must also support commercial managed models through opt-in provider adapters. Users choose the provider/model independently for embeddings, reranking, generation, summarization, and agent reasoning:

- **OpenAI:** OpenAI API models for embeddings and generation (including models used by ChatGPT, where available through the API).
- **Anthropic:** Claude models for generation and agent reasoning; use a separate embeddings adapter because Anthropic does not provide one as part of this integration.
- **Google:** Gemini models for generation and Google embedding models through the Gemini API.
- **Open-weight/self-hosted:** Ollama, vLLM, llama.cpp servers, Hugging Face Text Embeddings Inference (TEI), SentenceTransformers/cross-encoder HTTP services, and any OpenAI-compatible endpoint.

Do **not** ship an opaque “magic vector DB” or an LLM key in node configuration. Every external request must be visible in status/debug metadata and configurable through credentials/config nodes.

## 2. Product model

The durable unit is a **library**: a named, isolated collection of documents, chunks, schemas, access policy, and backend references. A document has a stable ID, document metadata, source metadata, and ordered chunks. A chunk is the smallest retrievable/citable unit.

```
record/file
  → extract → normalize → split → embed + lexical-index → library
  → retrieve (dense + lexical + filters) → rerank → evidence
  → prompt + evidence → model → answer + citations
```

Model it as composable Node-RED nodes. A flow can stop after any stage and use the output elsewhere. “Ask library” is only a convenience composition of retrieval + generation, never the only path.

### Terms

| ContextWeave term | Meaning |
| --- | --- |
| Library | isolated knowledge collection; analogous to a corpus, but independently named |
| Document | source object with stable ID and metadata |
| Chunk | indexed, retrievable passage/table/image-caption reference |
| Evidence | the ranked set of chunks returned to a flow |
| Retrieval recipe | hybrid-search, filter, context, and reranker configuration |
| Answer trace | evidence IDs, prompt/model metadata, citations, timings, and warnings |
| Conversation | bounded state containing prior turns and optional session metadata |

## 3. Package shape

```
node-red-contrib-context-weave/
  package.json
  README.md
  LICENSE
  nodes/
    config/             # providers, credentials, library connection
    library/            # library and document lifecycle
    ingest/             # file and record ingestion pipeline
    connectors/         # source envelopes, checkpoints, custom parser bridges
    retrieve/           # retrieval, filters, reranking
    generate/           # answer generation and document summary
    agent/              # conversations, tools, agent run
    observability/      # traces, export, evaluation
  lib/
    core/               # canonical types, validation, errors
    adapters/           # vector, lexical, embeddings, llm, extractor
    policies/           # ACL/filter compiler, redaction, limits
  test/
  examples/
```

Expose a narrow adapter interface. Node implementations call `LibraryService`, `RetrievalService`, `GenerationService`, and `ConversationStore`; they must not directly call a particular vector DB or model vendor.

## 4. Configuration nodes (no message input)

### 4.1 `ContextWeave provider`

Credential/config node. Stores provider type, base URL, secret reference, model IDs, timeout, retry policy, and optional organization/project. Secrets use Node-RED credential storage only; never serialize them into flow JSON, status text, debug payload, or error messages.

The editor presents two configurations: a **provider connection** (credentials and endpoint) and a reusable **model profile** (purpose, selected model, and safe request defaults). One provider may have several profiles, for example `openai-fast-answer`, `claude-policy-review`, `gemini-long-context`, `local-embeddings`, and `ollama-private-chat`.

Supported initial provider roles:

- embedding provider (required for indexing/retrieval)
- generation provider (required for generation/agent nodes)
- vector provider
- lexical provider (optional)
- reranker provider (optional)
- extraction provider (optional)

#### Provider adapters

| Adapter | Typical capabilities | Required configuration | Notes |
| --- | --- | --- | --- |
| `openai` | generation, structured output when supported, embeddings, streaming | API key, optional organization/project, model IDs | Use the official API directly; do not use browser/ChatGPT session credentials. |
| `anthropic` | generation, tool use when supported, streaming | API key, model ID, API version/header managed by adapter | Pair with a separate embedding profile. |
| `google-gemini` | generation, embeddings, streaming | Gemini API key or supported Google credential method, model IDs | Expose generation and embedding models as distinct profiles. |
| `openai-compatible` | generation and/or embeddings, streaming when endpoint supports it | base URL, API key optional, model IDs, compatibility toggles | For vLLM, LM Studio, LocalAI, Together-compatible endpoints, and gateways. |
| `ollama` | generation, embeddings, streaming | local/remote base URL, generation and embedding model IDs | Default to local loopback; remote endpoints require explicit TLS/auth configuration. |
| `huggingface-tei` | embeddings, optional reranking endpoint | base URL, token optional, model metadata | Prefer TEI for self-hosted embedding services. |
| `cross-encoder` | reranking | base URL, token optional, model ID/capability | Small interface: query + passages → scores. |

The code must feature-detect capabilities from the adapter rather than assume a model family can perform a role. For example, selecting a Claude profile in `index` is a validation error because it is not an embedding profile; selecting a text-only model for image extraction is likewise invalid.

#### `ContextWeave model profile`

This optional config node makes model selection portable across flows. Fields:

- `id`, display name, provider connection, and `purpose`: `generation`, `embedding`, `reranking`, `vision`, or `extraction`.
- exact upstream `model` identifier; optional fallback profiles in priority order.
- input/output limits set conservatively below the adapter-advertised maximum.
- generation defaults: temperature, top-p, max output tokens, seed (when supported), JSON/structured-output mode, and tool-use enablement.
- embedding defaults: dimensions (if selectable), batch size, normalization policy, and model revision.
- privacy policy: `local-only`, `allow-commercial-api`, or `commercial-api-with-redaction`; model labels must make outbound data transfer clear.
- cost controls: per-run budget estimate, monthly soft cap, concurrency cap, and “fail rather than fallback” option.

Profiles are immutable by version after first production use. Editing a profile creates a new revision; indexing records the embedding profile revision on every chunk. An embedding profile change demands reindexing, while a generation-profile change does not.

Validate connectivity with a redacted “Test connection” editor action. Version adapter capabilities (e.g., `supportsStreaming`, `supportsJsonMode`, `maxBatchItems`) instead of hard-coding vendor names.

### 4.2 `ContextWeave library`

Config node that names a library and binds its provider nodes. Settings:

- `libraryId`: immutable machine key, `[a-z][a-z0-9_-]{1,62}`.
- display name and description.
- default embedding model/version; record it on every chunk.
- default chunking policy.
- metadata schema: typed, indexed/filterable fields and allowed operators.
- access policy mode: `none`, `tenant-field`, or custom policy hook.
- retention/deletion options.

Changing the embedding model must require an explicit **rebuild index** operation; mixing embeddings from incompatible models in one search space is prohibited. Schema changes should be additive by default; removing/changing an indexed field requires a migration/reindex confirmation.

Library configuration selects an **embedding model profile**. Retrieval must use the same compatible profile/model space, unless the library contains explicitly partitioned indexes and a query fan-out strategy. Answer, summary, and agent nodes select a **generation profile** at node level, allowing one library to use local embeddings with any supported commercial or local generation model.

### 4.3 `ContextWeave conversation store`

Config node for memory: in-memory (development only), Node-RED context, SQLite, Redis, or custom adapter. Require a TTL, max turns, and max retained characters/tokens. Session data must never silently become unbounded flow/global context.

### 4.4 `ContextWeave source profile`

Optional config node that makes an external Node-RED connector reusable across flows without coupling ContextWeave to the connector vendor. It stores only mapping and sync policy, not the connector's credentials.

- identity mapping: source-system name, item-ID property, URI property, modified-at property, title property, and tenant metadata property.
- content mapping: record/text property, file Buffer property, filename, MIME type, and optional parser hint.
- synchronization policy: dedupe key, content hash property, checkpoint property, and delete/tombstone property.
- parser route: `auto`, `built-in`, configured extraction provider, or `custom Node-RED branch`.

The external connector continues to own its authentication, scheduling, pagination, and source-specific cursor. This prevents credential duplication and means a user can use an existing private connector unchanged.

## 5. Canonical Node-RED message contract

Nodes accept configured values but allow a documented override from `msg.contextWeave`. Do not overload top-level `msg.payload` beyond input convenience; write canonical outputs below `msg.contextWeave`.

```js
msg.contextWeave = {
  requestId: "uuid",                 // create once, preserve downstream
  library: "support-kb",
  query: "How do I rotate the key?",
  input: { /* normalized source or caller input */ },
  evidence: [ /* EvidenceItem[] */ ],
  answer: { text: "...", citations: [], trace: {} },
  conversation: { id: "...", metadata: {} },
  warnings: [],
  metrics: { timingsMs: {}, counts: {} }
};
```

### 5.1 Required stable shapes

```ts
type DocumentInput = {
  id: string;
  title?: string;
  text?: string;
  sections?: Array<{ id?: string; title?: string; text: string; metadata?: Record<string, Scalar> }>;
  uri?: string;
  metadata?: Record<string, Scalar | Scalar[]>;
  acl?: { allow?: string[]; deny?: string[] }; // optional policy input, never client-trusted
};

type EvidenceItem = {
  evidenceId: string;
  library: string;
  documentId: string;
  chunkId: string;
  rank: number;
  score?: number;                      // comparable only within its named stage
  scores?: Record<string, number>;
  text: string;
  highlights?: Array<{ start: number; end: number }>;
  context?: { before?: string; after?: string };
  document: { title?: string; uri?: string; metadata?: Record<string, unknown> };
  chunkMetadata?: Record<string, unknown>;
  locator?: { sectionId?: string; charStart?: number; charEnd?: number; page?: number };
};

type Citation = {
  number: number;
  evidenceId: string;
  documentId: string;
  title?: string;
  uri?: string;
  quote?: string;
};
```

Every output must retain IDs, source URI (when safe), scores by stage, and offsets/locators. This is essential for inspectable citations and debugging.

## 6. Node catalogue and exact behavior

### A. Library lifecycle

| Node | Input | Output | Behaviour |
| --- | --- | --- | --- |
| `library-create` | optional `msg.contextWeave.librarySpec` | library descriptor | Creates storage/index namespaces and persists metadata schema. Idempotency key supported. |
| `library-list` | filters/pagination | `msg.contextWeave.libraries` | Lists only libraries allowed by configured server policy. |
| `library-info` | library ID | descriptor + size/statistics | Returns schema, provider versions, document/chunk counts, last indexing job. |
| `library-update` | patch object | updated descriptor | Allows name/description/additive schema/default recipes. Rejects unsafe changes without migration flag. |
| `library-reset` | library ID + `confirm: true` | reset report | Deletes indexed document/chunk data but preserves library config. Use a two-stage editor confirmation and audit event. |
| `library-delete` | library ID + `confirm: true` | deletion receipt | Deletes config and all associated data. Disabled by default in runtime settings. |

### B. Ingestion and document lifecycle

| Node | Input | Output | Behaviour |
| --- | --- | --- | --- |
| `file-ingest` | `msg.payload` Buffer/path (if runtime permits) or `{data, filename, mimeType}` | indexed document report | Extracts text/tables where adapter supports it, preserves supplied metadata, then submits to pipeline. Enforce configurable file/parse-time limits. |
| `source-map` | any connector message | normalized source envelope | Maps arbitrary Node-RED message properties to a stable source/item envelope; does not parse or index. |
| `parse-content` | normalized source envelope containing a file, HTML, Markdown, or text | parsed document/sections | Extracts text, tables, page/section locators, and parser warnings through the chosen parser route. |
| `record-ingest` | `msg.payload` or `msg.contextWeave.input.document` matching `DocumentInput` | indexed document report | Normalizes structured source. Use when caller controls document/section boundaries. |
| `split` | normalized document | document plus chunks | Deterministic splitter. Modes: sentence-window, token-window, paragraph, section, markdown headings, custom regex. Never span a section boundary by default. Persist splitter version/config. |
| `index` | document/chunks | `{documentId, chunksCreated, chunksUpdated, chunksDeleted}` | Upserts vectors + lexical entries atomically as far as adapter permits. Idempotent by document ID + content hash. |
| `document-get` | document ID | complete stored document | Retrieves source metadata and chunks only when policy allows it. |
| `document-list` | filter/page | document summaries | Returns no chunk text by default. |
| `document-patch` | document ID + metadata patch | updated descriptor | Merges metadata, reindexes filter fields only if needed. |
| `document-replace-metadata` | document ID + full metadata | updated descriptor | Replaces metadata exactly. |
| `document-delete` | document ID + `confirm` | receipt | Removes vectors, lexical entries, chunk rows, and source metadata. |
| `document-summarize` | document ID or normalized document | `msg.contextWeave.summary` + trace | Uses a generation provider with explicit template/model/limits. Supports normal and stream outputs. |

Ingestion rules:

1. Treat document ID as a stable business key; default file ID should be a content/path-derived UUID, not only a filename.
2. Extracted text, original metadata, parser version, content hash, and timestamps are separate fields.
3. If extraction or embedding partially fails, do not report a successful index. Emit to the error output with a recoverable job report and support safe retry.
4. Enforce a dead-letter branch for failed source records instead of dropping them.
5. Delete/reindex stale chunks when an updated document has fewer chunks than its previous version.

#### Bring-your-own-connector contract

Any Node-RED connector can be wired into `source-map` if it can put source data into `msg`. The user configures field paths; ContextWeave never needs to know whether the record came from SharePoint, Salesforce, a SQL query, a private HTTP API, or a new connector.

```js
// Expected output of source-map; safe, provider-neutral envelope.
msg.contextWeave.source = {
  system: "sharepoint",             // literal or mapped value
  itemId: "42",                     // stable source identity
  uri: "https://tenant.example/doc/42",
  modifiedAt: "2026-11-24T10:00:00Z",
  operation: "upsert",              // upsert | delete
  content: {
    kind: "file",                   // file | text | html | markdown | record
    data: msg.payload,               // Buffer/string/object; not copied if avoidable
    filename: "policy.pdf",
    mimeType: "application/pdf"
  },
  metadata: { tenant_id: "acme", source_folder: "Policies" },
  checkpoint: "connector-owned-cursor"
};
```

For a `delete` operation, `source-map` produces the stable ContextWeave document ID and routes directly to `document-delete`; it must not call a parser, splitter, or indexer. For `upsert`, the normal path is `source-map → parse-content → record-ingest → split → index`.

### C. Retrieval and evidence shaping

| Node | Input | Output | Behaviour |
| --- | --- | --- | --- |
| `retrieve` | `msg.contextWeave.query` (or configured property) | `msg.contextWeave.evidence` | Dense, lexical, or hybrid retrieval across one/many libraries. No LLM call. |
| `rerank` | query + evidence | reordered evidence | Applies one strategy or ordered strategy chain. Preserve prior scores. |
| `context` | evidence | enriched evidence | Adds surrounding text and/or highlight ranges. Cannot request sentence and character windows together. |
| `filter` | evidence + filter | filtered evidence | Applies post-retrieval policy/business filter. Security filters must instead be applied before retrieval. |
| `format-evidence` | evidence | text/JSON/Markdown prompt block | Stable citation tokens such as `[E:abc123]`; keep full evidence separately. |
| `query-history` | request/document/query filters | historical traces | Optional, local-only observability. Redact prompts/content unless explicitly enabled. |

#### `retrieve` editor fields

- one or more libraries; each can define its own `metadataFilter` and lexical weight.
- `mode`: `dense`, `lexical`, `hybrid` (default if lexical provider exists).
- `lexicalWeight`: 0.0 = dense only; 1.0 = lexical only. Start around 0.02–0.10 for hybrid search; make the default 0.05.
- candidate count (`fetchK`, default 25); final limit (`limit`, default 10); offset.
- pre-retrieval filter expression.
- include document/chunk metadata; return highlights; context window.
- security context property (default `msg.auth`), evaluated server-side to create mandatory filter clauses.

Implement a small typed filter grammar rather than evaluating user JavaScript or forwarding raw SQL:

```
tenant_id = $auth.tenantId AND status IN ["published", "approved"] AND created_at >= "2026-01-01"
```

Compile this grammar per backend with parameter binding. Reject unknown/non-filterable fields, unsafe property traversals, type mismatches, and missing required tenant claims. Apply mandatory access/tenant filters before dense retrieval, lexical retrieval, reranking, and generation. Never rely on a UI field for authorization.

#### Reranker strategies

`rerank` must support:

- `none` (preserve candidate order).
- `cross-encoder` (provider adapter; multilingual capable preferred).
- `mmr` (Maximal Marginal Relevance) with `diversityBias` 0–1; default 0.3.
- `rule` (deterministic score adjustment based on safe expressions over trusted metadata, e.g. freshness/authority).
- `chain` (ordered array of the above; each stage declares its own `limit` and optional cutoff).

Score semantics: cross-encoder normalized scores can have an operational cutoff (initial UI hint 0.5); raw vector/hybrid scores are backend-specific and must not be presented as equivalent. Do not sort a final chained result again by an earlier score.

### D. Grounded generation

| Node | Input | Output | Behaviour |
| --- | --- | --- | --- |
| `answer` | query + evidence | answer, citations, trace | Grounded answer from evidence only by default. Combines retrieve+rerank only when “retrieve automatically” is enabled. |
| `generate` | explicit messages/template + optional evidence | model response + trace | General LLM node; must mark result as ungrounded if no evidence was used. |
| `cite` | answer with `[E:id]` markers + evidence | normalized citation list/rendering | Validates/normalizes citations and can render `numeric`, `markdown`, or `html` forms. |
| `fact-check` | answer + evidence | support assessment | Optional second-pass entailment/provider check. Never call a generated score “truth”. |

`answer` editor fields:

- generation model profile (or an explicit compatible provider/model override); system instructions; answer template; temperature; max output tokens.
- max evidence chunks/characters (defaults: 8 chunks, 24k characters) to prevent context explosion.
- citation mode: `numeric`, `markdown`, `html`, or `structured` (default structured + numeric display).
- answer policy: `answer-only-from-evidence` (default), `say-unknown`, and no-evidence fallback message.
- `requireCitations` (default true); `minimumCitations` (default 1 when evidence exists).
- stream mode: `off`, `tokens`, `final-only`.

The generated prompt must instruct the model to use only supplied evidence, cite exact evidence tokens for factual claims, and state when evidence is insufficient. Parse evidence markers only if they map to returned evidence IDs. Strip invented or malformed markers and place a warning in the trace. If citation requirement is unmet, route to a **validation failure** output rather than silently presenting an unsupported answer.

### E. Conversations and agents

Chats are a deprecated pattern in current Vectara documentation; favor explicit sessions/conversations and tool-capable agents instead. In `ContextWeave`, keep this optional and modest for v1.

| Node | Input | Output | Behaviour |
| --- | --- | --- | --- |
| `conversation-open` | optional session key/metadata | conversation descriptor | Creates or resumes state. Enforce TTL and principal/tenant binding. |
| `conversation-turn` | conversation + user message | appended turn | Persists user/assistant turn only after model validation succeeds. |
| `conversation-read` | ID | bounded history | Returns policy-permitted turns only. |
| `conversation-delete` | ID + confirm | receipt | Permanently removes conversation memory. |
| `agent-run` | user input + tool config | answer, events, trace | Executes a bounded tool loop with approved `ContextWeave` retrieval tools and explicit HTTP tools. |
| `agent-tool` | tool call event | tool result | Adapter node for a user-provided, schema-validated Node-RED branch. |

Agent v1 guardrails:

- A tool has a JSON Schema input/output contract, timeout, max calls, and allowlisted target/operation.
- Default maximum: 5 tool calls and 60 seconds per agent run.
- A retrieval tool uses the same mandatory library filters as `retrieve`.
- Separate “suggest action” from effectful actions. Any e-mail, webhook mutation, database write, or shell-like action must be implemented as a distinct flow branch with user-configurable approval/policy.
- Stream events are observational; the final persisted output is authoritative.

An agent may use a different generation profile from `answer`, but all tool inputs/outputs and retrieved evidence remain provider-neutral. Never make agent behavior depend on vendor-specific hidden conversation state; persist the normalized conversation in the configured conversation store.

## 7. Per-node requirements and editor configuration mockups

This section is the implementation contract for the Node-RED editor (`.html`) and runtime (`.js`) for every node. A mockup represents the editor fields and grouping, not a required pixel-perfect design.

### 7.1 Shared runtime and editor rules

Every non-config node has one input, one success output, and one error output unless its specification explicitly adds an event output. Each runtime node must:

- call `RED.util.evaluateNodeProperty` or an equivalent safe typed-input evaluation routine; never use `eval`.
- create `msg.contextWeave.requestId` if it does not exist; preserve it otherwise.
- set a concise status while executing and clear it on completion; errors use `node.error(error, msg)` and error output.
- expose `name`, `library`, and relevant input properties as typed inputs (`str`, `msg`, `flow`, `global`, `env`), except secrets, which only live in credential config nodes.
- validate configuration in both the editor and runtime. The runtime is authoritative.
- not mutate the source input property unless the node has an explicit “replace input” option (default false).

All runtime nodes share this editor footer:

```text
┌──────────────────────── ContextWeave node ───────────────────────┐
│ Name  [_______________________________________________]          │
│ Status detail  (•) Standard  ( ) Verbose trace                    │
│ On error        [Send to error output ▼]                          │
│                         [Cancel]  [Done]                          │
└──────────────────────────────────────────────────────────────────┘
```

`Standard` emits IDs, counts, timings, and warnings. `Verbose trace` additionally emits redacted provider/model metadata and prompt/evidence size; it never emits credentials or full source text by default.

### 7.2 Configuration nodes

#### `provider`

**Requirement:** credential config node; no wires. It must own credentials and advertise its capabilities to dependent model profiles. It cannot be deleted while a model profile references it.

```text
┌──────────────────────── Provider ────────────────────────────────┐
│ Name              [Production OpenAI________________]             │
│ Adapter           [OpenAI ▼]                                      │
│ Base URL          [https://api.openai.com/v1________]             │
│ API key           [••••••••••••••••••••••••________]             │
│ Request timeout   [60] seconds       Retry policy [Default ▼]     │
│ Test connection   [Test]    ✓ generation · embeddings · streaming │
│                                                   [Cancel] [Done] │
└──────────────────────────────────────────────────────────────────┘
```

Required fields: `name`, `adapter`, `baseUrl` where adapter needs one, and adapter-specific credential fields. Optional fields: organization/project, proxy, custom headers (credential-only), timeout, retry policy, and TLS CA reference. The adapter selector controls which fields appear. Test connection must save nothing and display only redacted diagnostics.

#### `model-profile`

**Requirement:** reusable, versioned purpose-specific profile; no wires. It rejects an unsupported role/capability pairing and records an immutable revision when saved after first use.

```text
┌────────────────────── Model profile ─────────────────────────────┐
│ Name       [fast-grounded-answer____________________]             │
│ Provider   [Production OpenAI ▼]   Purpose [Generation ▼]         │
│ Model      [gpt-4.1-mini____________________________]             │
│ Temperature [0.20]  Max output [1200]  Context cap [24000] chars  │
│ Privacy     [Allow commercial API ▼]                               │
│ Fallback    [local-answer ▼] [+ Add fallback]                     │
│ Capabilities  ✓ stream  ✓ JSON  ✓ tools   [Refresh]               │
│                                                   [Cancel] [Done] │
└──────────────────────────────────────────────────────────────────┘
```

Required: `name`, `provider`, `purpose`, `model`. Generation adds temperature/top-p/max output/structured-output/tools; embedding adds dimensions, batch size, normalization, and revision; reranking adds batch size and candidate cap. Privacy choices are `local-only`, `allow-commercial-api`, and `commercial-api-with-redaction`. Fallbacks must satisfy the same purpose and equal-or-stricter privacy policy.

#### `library`

**Requirement:** named collection config node; no wires. Library ID is immutable after creation. It binds vector, lexical, extraction, and embedding profiles and owns the indexed metadata schema.

```text
┌──────────────────────── Library ─────────────────────────────────┐
│ Name [Support knowledge base____________]  ID [support-kb_______] │
│ Embeddings [local-embed-v1 ▼]   Vector store [Qdrant main ▼]     │
│ Lexical index [SQLite FTS5 ▼]   Extractor [Tika local ▼]          │
│ Chunking [Sentence window ▼]  size [800]  overlap [120]           │
│ Filterable metadata                                             │
│   Field [tenant_id____] Type [string ▼] Required [✓] [+ Add]      │
│ Access policy [Tenant field ▼] Claim [msg.auth.tenantId________] │
│                                      [Validate] [Cancel] [Done]  │
└──────────────────────────────────────────────────────────────────┘
```

Required: `id`, embedding profile, vector provider, chunking policy. Optional: lexical/extraction provider, description, retention, metadata schema, default retrieval recipe, and policy hook. Changing the embedding profile must show an explicit reindex requirement and cannot silently apply to existing chunks.

#### `conversation-store`

**Requirement:** config node; no wires. It provides a secure state adapter to conversation and agent nodes.

Required: adapter, TTL, max turns, max stored characters/tokens. SQLite/Redis/custom adapters also require connection config. In-memory mode shows a development-only warning.

### 7.3 Library lifecycle nodes

| Node | Required input | Editor configuration | Success output | Additional requirements |
| --- | --- | --- | --- | --- |
| `library-create` | optional `msg.contextWeave.librarySpec` | library spec source; idempotency-key source | `contextWeave.library` | Rejects duplicate ID unless same idempotency key/spec. |
| `library-list` | optional query/filter | page size; cursor source; include statistics toggle | `contextWeave.libraries`, `page` | Never exposes libraries outside trusted caller policy. |
| `library-info` | library ID | library source; include schema/statistics toggles | `contextWeave.library` | Read-only; must not trigger a size recomputation unless explicitly selected. |
| `library-update` | patch object | library source; patch source; `requireMigrationAck` | `contextWeave.library` | Rejects unsafe schema/model changes without acknowledgement. |
| `library-reset` | library ID + confirmation | library source; confirmation property; dry-run toggle | `contextWeave.operation` | Requires literal/configured `confirm: true`; disabled by runtime policy by default. |
| `library-delete` | library ID + confirmation | library source; confirmation property; dry-run toggle | `contextWeave.operation` | Requires typed ID match plus `confirm: true`; audit mandatory. |

**Lifecycle dialog mockup** (the selected action changes the final section):

```text
┌──────────────────────── Library: reset ──────────────────────────┐
│ Library              [support-kb ▼]                               │
│ Confirmation source  [msg.contextWeave.confirm ▼]                 │
│ Required value       true                                          │
│ (✓) Dry run — report document/chunk counts only                   │
│ ⓘ Reset removes indexed content but keeps the library definition. │
│                                                    [Cancel] [Done]│
└──────────────────────────────────────────────────────────────────┘
```

`library-create` uses an editable JSON-schema-validated library spec only for dynamic libraries. Normal flows should reference the `library` config node. `library-list`, `library-info`, `library-update`, `library-reset`, and `library-delete` must present a library typed-input and must not offer provider credentials.

### 7.4 Ingestion and document nodes

| Node | Required input | Editor configuration | Success output | Additional requirements |
| --- | --- | --- | --- | --- |
| `file-ingest` | Buffer/path/object with `data`, `filename`, `mimeType` | library; source property; filename/mime properties; metadata source; parse limits; upsert mode | `contextWeave.document`, `contextWeave.job` | Runtime file paths disabled by default; allow only configured safe roots. |
| `source-map` | any Node-RED message from a connector | source profile; source-item, content, metadata, operation, and checkpoint mappings | `contextWeave.source` | Does not own connector credentials or run polls. Delete operations use a separate output. |
| `parse-content` | `contextWeave.source` | parser route; parser profile; extraction mode; file/parse limits; destination property | parsed document/sections | Supports auto, built-in, remote extractor, and custom-branch parsing. |
| `record-ingest` | `DocumentInput` | library; document source; ID/title/text mapping; metadata source; validation mode | normalized `contextWeave.input.document` | Fails if no stable ID or no text/sections. |
| `split` | normalized document | strategy; size; overlap; section-preservation; destination property | `contextWeave.input.chunks` | Deterministic output; warns when a chunk exceeds target due to atomic content. |
| `index` | document plus chunks or indexable text | library; document/chunk source; mode `upsert/create-only`; idempotency-key source | `contextWeave.index` | Removes stale chunks during upsert; only outputs success after both indexes commit. |
| `document-get` | document ID | library; ID source; include chunks/original text toggles | `contextWeave.document` | Policy applies before lookup. |
| `document-list` | optional filter/page | library; filter source; cursor/page size; include counts toggle | `contextWeave.documents`, `page` | Does not return full chunk text. |
| `document-patch` | document ID + metadata patch | library; ID source; patch source | `contextWeave.document` | Merge only; empty patch is validation error. |
| `document-replace-metadata` | document ID + full metadata | library; ID source; metadata source | `contextWeave.document` | Exact replacement; preserves protected/system fields. |
| `document-delete` | document ID + confirmation | library; ID source; confirmation source; dry run | `contextWeave.operation` | Vectors, lexical entries, chunks, and stored source are all deleted. |
| `document-summarize` | document ID or document object | library; target source; generation profile; template; stream mode | `contextWeave.summary` | Uses only authorized text and obeys generation privacy profile. |

**File/record ingestion mockup:**

```text
┌────────────────────── File ingest ───────────────────────────────┐
│ Library        [support-kb ▼]                                     │
│ Source          [msg.payload ▼]       Input type [Auto detect ▼]  │
│ Filename        [msg.filename ▼]      MIME type [msg.mimeType ▼]  │
│ Document ID     [msg.documentId ▼]    Upsert [By document ID ▼]   │
│ Metadata        [msg.metadata ▼]      Max file size [10] MB       │
│ Parse timeout   [60] seconds          [ ] Store original file     │
│ On duplicate    [Replace indexed chunks ▼]                        │
│                                                    [Cancel] [Done]│
└──────────────────────────────────────────────────────────────────┘
```

**Bring-your-own-connector and parser mockup:**

```text
┌──────────────────────── Source map ──────────────────────────────┐
│ Source profile [SharePoint policy files ▼]                         │
│ Item ID       [msg.payload.id ▼]  URI [msg.payload.webUrl ▼]      │
│ Content       [msg.payload.file ▼] Kind [File ▼]                  │
│ Filename      [msg.payload.name ▼] MIME [msg.payload.mimeType ▼]  │
│ Metadata      [msg.payload.metadata ▼]  Operation [Upsert ▼]      │
│ On delete  [Output 2: document-delete route ▼]                    │
│                                                    [Cancel] [Done]│
└──────────────────────────────────────────────────────────────────┘

┌────────────────────── Parse content ─────────────────────────────┐
│ Source envelope [msg.contextWeave.source ▼]                       │
│ Parser route [Auto (by MIME type) ▼]                              │
│ Fallback parser [Built-in Markdown / HTML ▼]                      │
│ Extract [✓] text  [✓] tables  [ ] images/OCR                      │
│ Max file [10] MB       Parse timeout [60] seconds                 │
│ Output [msg.contextWeave.input.document____________________]     │
│                                                    [Cancel] [Done]│
└──────────────────────────────────────────────────────────────────┘
```

`source-map` has two outputs: **upsert** and **delete**. `parse-content` has success and error outputs, plus an optional parsed-artifacts output when table/image extraction is enabled. A custom parser route writes the source envelope to an ordinary Node-RED branch; that branch must return a schema-valid `DocumentInput` to `record-ingest`.

**Split/index mockup:**

```text
┌──────────────────────── Split ───────────────────────────────────┐
│ Document source [msg.contextWeave.input.document ▼]               │
│ Strategy [Sentence window ▼]  Target [800] tokens  Overlap [120]  │
│ [✓] Keep section boundaries  [✓] Preserve locator offsets         │
│ Output chunks [msg.contextWeave.input.chunks________________]     │
│                                                    [Cancel] [Done]│
└──────────────────────────────────────────────────────────────────┘
```

`document-get`, `document-list`, `document-patch`, `document-replace-metadata`, and `document-delete` use the same compact editor layout: library selector; ID/filter/patch property; output-detail or confirmation options. `document-summarize` uses the `answer` model/profile section but has no retrieval fields.

### 7.5 Retrieval and evidence nodes

| Node | Required input | Editor configuration | Success output | Additional requirements |
| --- | --- | --- | --- | --- |
| `retrieve` | query text | libraries; query source; dense/lexical/hybrid mode; per-library filters/weights; candidate/final limits; context settings | `contextWeave.evidence` | Mandatory policy filter is injected before any backend call. |
| `rerank` | query + evidence | strategy/chain; profile; stage limits/cutoffs; diversity bias; safe rule | reordered `contextWeave.evidence` | Preserves all prior scores and never re-sorts the final chain by an earlier score. |
| `context` | evidence | sentence or character window; tags; max total chars | enriched evidence | Sentence and character windows are mutually exclusive. |
| `filter` | evidence | typed filter source; unknown-field policy | filtered evidence | For business/display filtering only; cannot bypass library ACLs. |
| `format-evidence` | evidence | output property; `text/json/markdown`; citation token pattern; per-item/max-total chars | `contextWeave.promptEvidence` | Must keep evidence IDs alongside rendered text. |
| `query-history` | optional request/document/query filters | library; time range; cursor/page size; content visibility policy | `contextWeave.history`, `page` | Content is redacted unless local policy explicitly permits it. |

**Retrieve mockup:**

```text
┌──────────────────────── Retrieve ────────────────────────────────┐
│ Query source [msg.payload ▼]       Mode [Hybrid ▼]                │
│ Libraries                                                        │
│   [support-kb ▼]  lexical weight [0.05]  filter [status="live"]  │
│   [+ Add library]                                                 │
│ Fetch candidates [25]     Return evidence [8]     Offset [0]      │
│ Context [2 sentences before / 2 after ▼]   Highlights [✓]         │
│ Security context [msg.auth ▼]  Output [msg.contextWeave.evidence]│
│                                                    [Cancel] [Done]│
└──────────────────────────────────────────────────────────────────┘
```

**Rerank mockup:**

```text
┌──────────────────────── Rerank ─────────────────────────────────┐
│ Query    [msg.contextWeave.query ▼]                               │
│ Evidence [msg.contextWeave.evidence ▼]                            │
│ Strategy [Chain ▼]                                                │
│   1. Cross-encoder [multilingual-rerank ▼] cutoff [0.50] top [30] │
│   2. MMR                               diversity [0.30] top [10] │
│   3. Rule [freshness-adjustment ▼]                    top [8]     │
│ Output [msg.contextWeave.evidence___________________________]     │
│                                                    [Cancel] [Done]│
└──────────────────────────────────────────────────────────────────┘
```

The filter editor must provide a syntax/help popover and validate against the selected library schema. `context` must visually disable character controls while sentence context is selected, and vice versa. `query-history` must show a privacy warning whenever “include text” is enabled.

### 7.6 Generation and citation nodes

| Node | Required input | Editor configuration | Success output | Additional requirements |
| --- | --- | --- | --- | --- |
| `answer` | query + evidence, or query when automatic retrieve enabled | generation profile; instructions/template; evidence source/budgets; citation policy; automatic retrieval recipe; stream mode | `contextWeave.answer` | Validates citations; no-evidence fallback is explicit. |
| `generate` | messages/template, optional evidence | generation profile; messages source/template; JSON mode; tools; stream mode | `contextWeave.generation` | Marks output `grounded: false` when evidence is absent. |
| `cite` | answer text + evidence | answer/evidence sources; marker syntax; rendering mode; missing-citation policy | normalized answer/citations | Removes invented markers and can fail validation. |
| `fact-check` | answer + evidence | verifier profile; assertion extraction mode; support threshold; strictness | `contextWeave.factCheck` | Reports support/uncertainty, not factual truth. |

**Answer mockup:**

```text
┌──────────────────────── Answer ──────────────────────────────────┐
│ Generation profile [fast-grounded-answer ▼]   Stream [Events ▼]   │
│ Query source       [msg.contextWeave.query ▼]                     │
│ Evidence source    [msg.contextWeave.evidence ▼]                  │
│ Max evidence       [8] chunks   [24000] chars                     │
│ Instructions                                                   │
│ [Answer only from evidence. Cite each factual claim.__________]  │
│ Citation format [Structured + numeric ▼]  Require citations [✓]  │
│ If no evidence   [State that the library has no answer ▼]         │
│ [ ] Retrieve automatically     Output [msg.contextWeave.answer]  │
│                                                    [Cancel] [Done]│
└──────────────────────────────────────────────────────────────────┘
```

`generate` shares the profile/output/stream controls but replaces evidence policy with a messages/template editor. `cite` presents a choice of `numeric`, `markdown`, `html`, or `structured` rendering. `fact-check` requires a profile capable of the selected verification mode and must warn if the source answer is ungrounded.

### 7.7 Conversation and agent nodes

| Node | Required input | Editor configuration | Success output | Additional requirements |
| --- | --- | --- | --- | --- |
| `conversation-open` | optional requested ID/metadata | store; ID source/strategy; principal source; metadata source; resume mode | `contextWeave.conversation` | Principal/tenant binding is immutable after creation. |
| `conversation-turn` | conversation + user/assistant turn | store; conversation source; role; text source; persist timing | updated conversation/turn | Assistant output persists only after validation. |
| `conversation-read` | conversation ID | store; ID source; max turns; include system toggle | `contextWeave.conversation.history` | Enforces principal/tenant binding. |
| `conversation-delete` | conversation ID + confirmation | store; ID/confirmation source; dry run | `contextWeave.operation` | Audit mandatory. |
| `agent-run` | user input + conversation optional | generation profile; store; tools; max calls/time; retrieval permissions; instructions; stream mode | answer/events/trace | Tool calls require schema validation and allowlisting. |
| `agent-tool` | tool-call event | tool ID; input schema; output schema; timeout; result property | schema-validated tool result | Never performs an effectful action without the downstream flow's explicit policy/approval. |

**Agent-run mockup:**

```text
┌──────────────────────── Agent run ───────────────────────────────┐
│ Agent name [Support assistant_______________]                     │
│ Generation profile [reasoning-agent ▼]  Conversation store [Redis]│
│ User message [msg.payload ▼]  Conversation [msg.contextWeave.conversation.id ▼]│
│ Instructions [Use tools when needed; cite retrieved evidence.__]  │
│ Tools                                                            │
│   [✓] Library retrieval   [support-kb ▼]   max results [8]        │
│   [ ] HTTP lookup         (requires approved allowlist)           │
│ Max tool calls [5]  Run timeout [60] sec  Stream [Events ▼]       │
│                                                    [Cancel] [Done]│
└──────────────────────────────────────────────────────────────────┘
```

`conversation-open`, `conversation-turn`, `conversation-read`, and `conversation-delete` use a store selector and typed ID/property fields. `agent-tool` has no provider selection; it maps an already-approved tool call to a normal Node-RED branch and validates its result before returning it to `agent-run`.

### 7.8 Ports, node colour, and help requirements

| Node family | Inputs | Outputs | Suggested status/node colour |
| --- | --- | --- | --- |
| configuration | none | none | neutral config node |
| lifecycle/document | 1 | success, error | blue/teal; show operation count |
| ingest/index | 1 | success, error | teal; show parsed/indexed count |
| retrieval/evidence | 1 | success, error | violet; show evidence count |
| generation/citation | 1 | event (when streaming), success, error | amber; show generating/validating |
| conversation/agent | 1 | event (when streaming), success, error | purple; show turn/tool count |

Every node help panel must contain: purpose; required config nodes; input property paths; output property paths; a minimal flow example; error codes; privacy/outbound-data behavior; and a link to the matching example flow. Nodes with deletion, reset, live HTTP, or commercial-model transfer also require a “Safety” help subsection.

### 7.9 Importable example flow

The repository includes an importable [support flow](../examples/support-rag.json) with two lanes in one tab.

1. A connector-ready article ingestion path: `source-map` → `parse-content` → `record-ingest` → `split` → `index`.
2. A `POST /context-weave/ask` path: validate request → `retrieve` → `rerank` → `answer` → HTTP response.

The example uses type IDs prefixed with `context-weave-` to prevent collisions in Node-RED (`context-weave-retrieve`, `context-weave-answer`, and so on), while the visible palette labels stay short (`retrieve`, `answer`). It is importable after the package exists; before then, Node-RED will mark ContextWeave nodes as unknown, which is expected.

## 8. Streaming contract

For extraction, generation, summarization, and agent runs, give the node two output ports: **event** and **complete**; retain a third standard **error** port where Node-RED supports it. Do not emit partial text on the normal completed message.

```js
// event output
msg.contextWeave.event = {
  type: "generation.delta", // run.started, retrieval.completed, tool.called, generation.delta, run.completed, run.error
  sequence: 12,
  text: "partial text",
  requestId: msg.contextWeave.requestId
};

// complete output
msg.contextWeave.answer = { text: "complete", citations: [...], trace: {...} };
```

Use monotonically increasing `sequence`, an abort signal on node close/deploy, backpressure-safe buffering, and a terminal event even after recoverable errors. Do not promise token-level events from a provider that only offers chunks.

## 9. Errors, status, retries, and idempotency

Each operational node has a dedicated error output and calls `node.error(error, msg)`. Use this serializable error form:

```ts
type ContextWeaveError = {
  code: "VALIDATION" | "AUTH" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" |
        "UPSTREAM" | "TIMEOUT" | "EXTRACTION" | "INDEXING" | "POLICY" |
        "GENERATION" | "CITATION_VALIDATION" | "CANCELLED";
  message: string;           // safe for Node-RED debug UI
  retryable: boolean;
  retryAfterMs?: number;
  requestId: string;
  cause?: { provider: string; status?: number }; // no secret/prompt content
};
```

- Retry only idempotent operations automatically: retrieval and upsert with a stable ID/idempotency key.
- Use exponential backoff with jitter and honor `Retry-After`; configurable defaults: 3 attempts, 500 ms base, 20 s cap.
- Never retry delete, agent tools, or a possibly executed write without an idempotency key and provider confirmation.
- Show concise node status: `indexing 14/32`, `retrieving`, `reranking`, `generating`, `rate limited`, `error`. Do not expose query text, document text, or secrets there.
- Include timings for extraction, embedding, vector/lexical retrieval, each reranker, prompt build, provider latency, and total duration.

## 10. Privacy, security, and operational controls

1. **Credentials:** Node-RED encrypted credential storage; redact `Authorization`, API keys, cookies, presigned URLs, and provider response headers.
2. **Tenancy/ACL:** derive tenant/principal filters from trusted flow context or gateway-injected claims. Do not accept `tenantId` solely from a public HTTP request body.
3. **SSRF:** extraction/web-loader and HTTP tools require protocol, host allowlist, DNS/IP private-range checks, redirect validation, size limits, and timeouts.
4. **Prompt injection:** label retrieved text as untrusted data; do not execute its instructions; isolate agent tool authorization from retrieved content.
5. **Data minimization:** let users choose whether to store original files, extracted text, embeddings, prompts, answers, and traces. Implement retention/deletion jobs consistently across every backend.
6. **Audit:** append lifecycle operations, access-policy rejections, provider/model version changes, and destructive actions to a local audit sink. Redact content by default.
7. **Limits:** document size, chunks/document, chunks/request, retrieval candidates, prompt chars, output tokens, concurrent runs, per-library quotas, and circuit breaker thresholds must all be configurable.
8. **Commercial-model disclosure:** Before a flow sends document text, evidence, or prompts to a commercial provider, the editor must show the destination/provider and selected privacy profile. Local-only libraries must reject such a run. Do not imply that a provider will train on, retain, or not retain data; link users to that provider's current data-policy documentation instead.
9. **Fallback safety:** Fall back only to a profile with an equal or stricter privacy policy, compatible capability, and sufficient context window. Include the selected/fallback profile revision in the answer trace; never silently switch a local-only workload to a commercial API.

## 11. Node editor/UX requirements

- Help text includes a minimal flow example, input/output property paths, and safe defaults.
- Configure required fields with typed inputs: literal, `msg`, `flow`, `global`, environment variable (where permitted).
- Provide JSON schema validation and an editor-side preview for metadata filters/templates, but repeat validation server-side.
- Make destructive nodes visually distinct, require a typed library ID or `confirm: true`, and support runtime disablement.
- Surface raw provider request/response only in an opt-in trace setting and redact by default.
- Include examples: PDF help center ingestion, CSV/product records, multi-library search, multilingual retrieval, tenant-safe RAG API, streaming answer, and agent with a human approval branch.

## 12. Implementation phases and acceptance criteria

### Phase 1 — useful, local RAG

Deliver config/library nodes, `record-ingest`, `split`, `index`, `retrieve`, `rerank` (MMR), `answer`, `cite`, and one vector + one OpenAI-compatible adapter.

Acceptance:

- A fresh Node-RED user can index two structured documents and answer a question with at least one verified citation.
- Changing a document and indexing it again removes obsolete chunks.
- A cross-tenant query cannot retrieve a chunk outside its enforced tenant filter.
- A no-evidence query produces the configured “unknown” response and no invented citation.
- Credentials do not appear in exported flows, debug output, trace output, or tests.
- A flow can select a commercial generation profile or a local OpenAI-compatible/Ollama profile without changing its message contract.
- An Anthropic generation profile cannot be selected where embeddings are required, and a changed embedding profile requires reindex confirmation.

### Phase 2 — production retrieval

Add file extraction, lexical/hybrid search, typed filter compiler, context windows/highlights, cross-encoder + rule chains, history/tracing, retry/circuit breaking, and document lifecycle nodes.

Acceptance:

- Hybrid mode exposes per-stage score metadata without treating raw scores as interchangeable.
- A chain can cross-encode → apply MMR → apply freshness rule, with stage-specific limits.
- Invalid filters and unknown fields fail before provider requests.
- File parsing failures route to an error output with actionable, redacted diagnostics.
- Managed OpenAI, Anthropic, and Gemini adapters and self-hosted Ollama/TEI adapters pass shared contract tests for their supported capabilities.

### Phase 3 — sessions and controlled agents

Add conversation store, streaming, `agent-run`, schema-governed tool bridges, and evaluation nodes.

Acceptance:

- Streaming emits ordered partial events followed by exactly one complete result or terminal error.
- Conversation history expires at configured TTL and cannot cross principal/tenant boundaries.
- Agent loop stops at call/time limits and cannot invoke unallowlisted tools.

## 13. Test plan

Use unit tests for type validation, splitter determinism, filter parsing/compilation, ACL injection, citation matching, reranker ordering, retry policy, redaction, and destructive-operation confirmation.

Use adapter contract tests with a deterministic fake embedding model/vector index/LLM. CI should not require paid providers. Use integration tests behind opt-in environment variables for Qdrant/pgvector/Ollama/OpenAI-compatible servers.

Required adversarial fixtures:

- duplicate document update with fewer chunks;
- deleted document absent from dense and lexical paths;
- special characters and Unicode in IDs/metadata;
- malicious metadata filter, prompt injection in source text, and malformed citations;
- table/large chunk context budget overflow;
- upstream 429/5xx/timeouts and cancellation during stream;
- two tenants with overlapping words and deliberately similar embeddings;
- downstream error branch receives a redacted, retry-classified error.

## 14. Design rationale from the research

The blueprint follows independently reusable architectural lessons from Vectara’s public documentation:

- Documents are decomposed into smaller retrievable units; retrieval systems return the unit with document metadata and locator information. This is why chunks/evidence/citations are first-class rather than just a string context blob.
- Retrieval quality comes from a pipeline: chunking, dense and lexical retrieval, metadata filtering, reranking, and grounding. The Node-RED nodes expose those steps rather than hiding them behind one query node.
- Hybrid lexical/dense weighting, pre-retrieval metadata filters, surrounding context, candidate/final limits, and reranker chains are necessary tuning controls.
- Rerankers solve different problems: semantic relevance, result diversity (MMR), and business rules such as freshness. Chaining them in separate nodes/stages preserves observability.
- Generation must remain optional, grounded in visible evidence, citation-validated, and streamable.
- New workflow design should prefer tool-capable, session-bounded agents over legacy chat endpoints, while keeping irreversible actions outside autonomous loops.

## 15. Research sources

These are conceptual sources only; implementations must be original and provider-neutral.

- [Vectara REST API v2 overview](https://docs.vectara.com/docs/rest-api/) — REST conventions, authentication, roles, and resource model.
- [Connect your data](https://docs.vectara.com/docs/build/connect-your-data) — indexed versus live-source ingestion patterns and source ACL caveats.
- [Create a corpus](https://docs.vectara.com/docs/rest-api/create-corpus) — collection-level metadata/filter configuration.
- [Upload a file to a corpus](https://docs.vectara.com/docs/rest-api/upload-file) — file extraction versus structured-document ingestion distinction.
- [Query a corpus with advanced options](https://docs.vectara.com/docs/rest-api/query-corpus) and [Tune retrieval](https://docs.vectara.com/docs/search-and-retrieval/tune-retrieval) — retrieval, filtering, context, hybrid controls, generation, and pagination.
- [Reranking](https://docs.vectara.com/docs/search-and-retrieval/reranking) — neural, MMR, rule-based, and chained ranking patterns.
- [Knowledge architecture](https://docs.vectara.com/docs/platform-architecture/knowledge) — chunking/retrieval/citation pipeline and agent retrieval configuration example.
- [Document summarization](https://docs.vectara.com/docs/rest-api/summarize-corpus-document) — stream event shape and document-aware generation.
- [Agents APIs overview](https://docs.vectara.com/docs/api-reference/agent-apis/agent-apis-overview) and [end-user sessions](https://docs.vectara.com/docs/agents/end-user-sessions) — explicit tools, sessions, and streaming-agent concepts.
- [Chats](https://docs.vectara.com/docs/rest-api/chats) — legacy chat endpoints are deprecated, informing the recommendation to use bounded conversations/agents.
