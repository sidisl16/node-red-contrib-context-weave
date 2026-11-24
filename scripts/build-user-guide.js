'use strict';

const fs = require('node:fs');
const {config} = require('../lib/definitions');
const fields = Object.assign({},config,require('../lib/ingest-fields'),require('../lib/knowledge-fields'),require('../lib/model-fields'));
const {choicesFor,conditionFor,describe,references} = require('./editor-schema');

const groups = {
  'Configuration nodes':['provider','model-profile','library','source-profile','conversation-store'],
  'Library lifecycle':['library-create','library-list','library-info','library-update','library-reset','library-delete'],
  'Ingestion and documents':['source-map','parse-content','record-ingest','file-ingest','split','index','document-get','document-list','document-patch','document-replace-metadata','document-delete','document-summarize'],
  'Retrieval and evidence':['retrieve','rerank','context','filter','format-evidence','query-history'],
  'Generation and citations':['answer','generate','cite','fact-check'],
  'Conversations and agents':['conversation-open','conversation-turn','conversation-read','conversation-delete','agent-run','agent-tool']
};

const design = fs.readFileSync('docs/design.md','utf8');
const catalogue = {};
for (const line of design.split('\n')) {
  const match=line.match(/^\| `([\w-]+)` \| (.*?) \| (.*?) \| (.*?) \|$/);
  if (match && !catalogue[match[1]]) catalogue[match[1]]={input:match[2],output:match[3],summary:match[4]};
}

const esc=value=>String(value).replaceAll('|','\\|').replaceAll('\n','<br>');
const code=value=>'`'+String(value).replaceAll('`','\\`')+'`';
function defaultText(value) {
  if (value === '') return '_empty_';
  if (Array.isArray(value) && !value.length) return '`[]`';
  if (value && typeof value === 'object') return code(JSON.stringify(value));
  return code(value);
}
function typeOf(value,key) {
  if (key.endsWith('Type')) return 'selector';
  if (Array.isArray(value)) return 'JSON array';
  if (value && typeof value === 'object') return 'JSON object';
  return typeof value;
}
function allowed(type,key,value) {
  const reference=key==='vectorProvider'?'provider':references[key];
  if (reference) return 'Select a **'+reference+'** configuration node.';
  const choices=choicesFor(type,key,value);
  if (choices) return choices.map(code).join(', ');
  if (typeof value === 'boolean') return '`true` or `false`';
  if (key.endsWith('SourceType')) return ['msg','str','flow','global','env','bool','num','json'].map(code).join(', ');
  return 'See “What it controls”; runtime validation applies.';
}
function when(type,key) {
  const rule=conditionFor(type,key);
  if (!rule) return 'Always';
  if (rule.truthy) return 'When '+code(rule.field)+' is enabled';
  if (rule.in) return 'When '+code(rule.field)+' is '+rule.in.map(code).join(' or ');
  return 'Except when '+code(rule.field)+' is '+rule.not.map(code).join(' or ');
}
function usage(type,isConfig) {
  if (isConfig) return 'Create it from a matching configuration selector, give it a clear name, save it, and reuse it in dependent nodes. It has no wires.';
  const item=catalogue[type]||{};
  return 'Wire a message containing **'+(item.input||'the required input')+'** into the node, configure the options below, and read **'+(item.output||'the result')+'** from the success/complete output. Always wire the error output during development and production.';
}

const out=[];
out.push(`# ContextWeave node user guide

This is the practical manual for building ContextWeave flows in Node-RED. It covers the supported behavior in this release, every node, and every editor option. Internal node type IDs begin with \`context-weave-\`, but the palette shows the shorter names used below.

## Start here

### The five-part mental model

1. **Connect data.** Use any Node-RED connector you already trust: HTTP, MQTT, SQL, S3, SharePoint, Google Drive, a private node, or an Inject node.
2. **Normalize and index it.** Use \`source-map → parse-content → record-ingest → split → index\`. For an already-structured document, start at \`record-ingest\`. For a single file, \`file-ingest\` is the shortcut.
3. **Retrieve evidence.** Use \`retrieve\`, then optionally \`rerank\`, \`context\`, \`filter\`, or \`format-evidence\`.
4. **Generate a grounded answer.** Use \`answer\` with a generation model profile. Use \`generate\` only when you intentionally need general model generation.
5. **Keep identity and errors explicit.** Set trusted \`msg.auth.tenantId\` (and \`msg.auth.sub\` for conversations), and wire every error output.

### Prerequisites

- Node.js 24.14 or newer and Node-RED 5.0.10 or newer.
- An embedding model for dense or hybrid retrieval. Ollama is the simplest local option.
- A generation model only for \`answer\`, \`generate\`, \`fact-check\`, \`document-summarize\`, and \`agent-run\`.
- SQLite works without a separate vector server. Qdrant, pgvector, and Chroma are optional.
- A Tika provider is needed for PDFs and other binary formats. Plain text, Markdown, HTML, and structured records use built-in parsing.

## Understanding libraries

A **library** is ContextWeave’s logical knowledge collection. It binds a stable library ID to one embedding model, an access policy, filterable metadata fields, and an optional external vector database. Documents, chunks, retrieval history, and index compatibility information belong to that library. It is not a folder watcher or source connector: your Node-RED connector supplies the records.

Do not confuse the two related pieces:

- The **\`library\` configuration node** defines the ID, embedding profile, privacy, access policy, filter schema, and vector backend. Other nodes select this configuration.
- The **library lifecycle nodes** perform actions against it. \`library-create\` initializes or describes it; \`library-info\` reports counts; \`library-update\` makes supported additive metadata changes; \`library-reset\` removes indexed contents but preserves the logical library; and \`library-delete\` marks it deleted after explicit confirmation.

### What is stored where

| Library setting | Dense vectors | Documents, chunks and metadata | Keyword index | Sync/history data |
| --- | --- | --- | --- | --- |
| No vector provider | Local SQLite | Local SQLite | Local SQLite FTS5 | Local SQLite |
| Qdrant, pgvector, or Chroma selected | External service, with a local durable vector copy | Local SQLite | Local SQLite FTS5 | Local SQLite |

The SQLite files live under the Node-RED user directory’s \`context-weave\` storage area. With the default tenant policy, each tenant gets an isolated hashed SQLite file and isolated vector scope. Back up this directory even when dense vectors are external.

### Configure a library step by step

1. Create a provider for the embedding service and a \`model-profile\` whose purpose is \`embedding\`.
2. Add a \`library\` configuration node. Give \`libraryId\` a stable lowercase machine key such as \`support-kb\`; do not rename it after indexing.
3. Select the embedding profile. Indexing always creates embeddings, including when you plan to retrieve in lexical mode.
4. Leave \`vectorProvider\` empty for SQLite. Select a Qdrant, pgvector, or Chroma provider only when you want external dense search.
5. Choose privacy deliberately. \`local-only\` rejects non-loopback services; an external or commercial endpoint requires a compatible outbound policy.
6. Keep the default tenant-field access policy for multi-tenant data. Supply trusted \`msg.auth.tenantId\`, and ensure every indexed document has matching \`metadata.tenant_id\`.
7. Define only metadata fields that must be validated or filtered, for example \`[{"name":"status","type":"string","required":true}]\`. Supported types are string, boolean, integer, float/number, date, and datetime.
8. Use \`library-create\` once if you want an explicit initialization receipt, then index documents. Storage is also created lazily on first permitted operation.

### Embedding compatibility and reindexing

A library records the embedding profile identity and the returned vector dimensions. Changing the provider, model, revision, dimensions, or normalization creates an incompatible vector space and indexing fails with a conflict instead of mixing vectors. To change embedding space, create a new library ID and reindex all source documents, validate retrieval, then retire the old library. Changing only the generation model used by \`answer\` does not require reindexing.

Do not switch an existing library between SQLite and an external vector provider in place. Use a new library ID, allow the source connector to replay its documents, validate counts with \`library-info\`, and then move retrieval to the new library.

### Access, filters, and multiple libraries

- Access policy is enforced before dense and lexical retrieval. A UI filter is not an authorization boundary.
- \`filterAttributes\` defines the metadata names and types permitted by the safe filter grammar. Expressions such as \`status = "published"\` are parameterized; raw SQL and JavaScript are rejected.
- Most operational nodes select one \`library\`. \`retrieve\` can use its main library or a JSON \`libraries\` list for multiple targets. Every selected library still applies its own tenant policy and embedding profile.
- \`library-list\` only lists explicitly selected/configured libraries; it does not scan arbitrary files on disk.
- Set \`allowDestructive\` only when reset/delete is operationally required. Keep \`dryRun\` on first, supply boolean confirmation, and require the exact library ID for deletion.

### First working flow

1. Import [the support RAG example](../examples/support-rag.json).
2. Open the \`provider\` nodes and verify their URLs. Keep privacy set to \`local-only\` for local Ollama.
3. Set an embedding model in the embedding \`model-profile\`, then select that profile in \`library\`.
4. Set a generation model in the generation \`model-profile\`, then select it in \`answer\`.
5. Deploy. Trigger the indexing Inject node once, then trigger the question Inject node.
6. Inspect \`msg.contextWeave.evidence\`, \`msg.contextWeave.answer\`, and the error outputs in Debug.

## Choosing configurations

| Need | Select | Important rule |
| --- | --- | --- |
| Local generation or embeddings | Ollama provider + matching model profiles | Keep \`baseUrl\` on loopback for \`local-only\`. |
| OpenAI, Claude, or Gemini generation | Provider + generation profile | Choose an outbound privacy policy deliberately; never paste browser-session credentials. |
| Dense search without another service | Blank library \`vectorProvider\` | SQLite stores vectors locally. |
| External dense search | Qdrant, pgvector, or Chroma provider in the library | SQLite still stores source text, lexical data, and the sync log. |
| PDF or office extraction | Tika provider selected as \`extractor\` | Choose parser route \`remote\` or \`auto\`. |
| A proprietary/private parser | Parser route \`custom\` | Wire the custom-parser output to your own branch and return a normalized document. |

## Message and output conventions

- Nodes read configured typed values from \`msg\`, flow context, global context, environment variables, or literals.
- Stable outputs are written below \`msg.contextWeave\`; the original message continues through the flow.
- \`source-map\` routes upserts and deletes separately. \`parse-content\` has a custom-parser branch. Generation nodes have event, complete, and error outputs.
- Error messages are deliberately safe and compact. Inspect \`msg.error.code\`, \`msg.error.requestId\`, and \`msg.error.retryable\`.
- Configuration nodes contain reusable settings and have no ports.
- Blank node-level mapping values may fall back to a selected \`source-profile\`. Explicit node values override that profile.

## Node reference
`);

for (const [group,nodes] of Object.entries(groups)) out.push('- **'+group+':** '+nodes.map(type=>'['+code(type)+'](#'+type+')').join(', '));

for (const [group,nodes] of Object.entries(groups)) {
  out.push('\n## '+group+'\n');
  for (const type of nodes) {
    const props=fields[type];
    if (!props) throw new Error('Missing field schema for '+type);
    const item=catalogue[type]||{};
    const isConfig=Object.hasOwn(config,type);
    out.push('### `'+type+'`\n');
    out.push((item.summary||('Reusable '+type.replaceAll('-',' ')+' configuration.'))+'\n');
    out.push('**How to use it:** '+usage(type,isConfig)+'\n');
    if (!isConfig) out.push('**Ports:** '+(item.input||'message input')+' → '+(item.output||'success result')+'; failures use the error output.\n');
    out.push('| Option | Type | Default | Allowed values / selection | Shown when | What it controls |\n| --- | --- | --- | --- | --- | --- |');
    const entries=[['name',''],...Object.entries(props)];
    if (type==='provider') entries.push(['apiKey','']);
    for (const [key,value] of entries) {
      out.push('| '+code(key)+' | '+esc(typeOf(value,key))+' | '+defaultText(value)+' | '+allowed(type,key,value)+' | '+when(type,key)+' | '+esc(describe(key))+' |');
    }
    out.push('');
  }
}

out.push(`## Common recipes

### Use your own connector

Wire the connector into \`source-map\`. Map a stable source system, stable item ID, content, metadata, and optional filename/MIME type. The connector continues to own authentication, polling, pagination, and checkpoints. Route upserts through parsing and indexing; route deletes to \`document-delete\` with an explicit confirmation policy.

### Choose dense, lexical, or hybrid retrieval

- **Dense** needs an embedding profile and is useful for semantic similarity.
- **Lexical** uses SQLite full-text search and needs no model call.
- **Hybrid** combines both. \`lexicalWeight\` is only shown for this mode; start with the default \`0.05\` and measure on representative questions.

### Use a commercial model safely

Create a provider and generation model profile, choose \`allow-commercial-api\` or \`commercial-api-with-redaction\`, and confirm that the library policy permits the transfer. ContextWeave sends the selected evidence and prompt to the provider. Never put API keys in Inject nodes, function code, flow JSON, or \`msg\`; use the provider credential field.

### Delete data safely

Keep \`dryRun\` enabled first. Supply boolean \`true\` at the configured confirmation source and verify the selected tenant/library/document. Library reset, library delete, document delete, and conversation delete are intentionally explicit.

## Production checklist

- Authenticate upstream and derive \`msg.auth\` from a trusted identity, not user-supplied JSON.
- Configure tenant access policy and filter attributes before indexing production data.
- Wire and monitor every error output; retain request IDs without logging secrets or full sensitive content.
- Use stable document IDs so retries are idempotent.
- Pin model names and embedding revisions. Reindex into a new library when embedding dimensions or model space changes.
- Back up the Node-RED user directory and SQLite files consistently, even when using an external vector database.
- Keep \`memory\` conversation storage for development only; use SQLite for durable bounded sessions.
- Test retrieval quality, filters, citations, and deletion in a staging flow before publishing.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| “Select a compatible model profile” | The node needs the right profile purpose: embedding, generation, or reranking, and the profile needs a model ID. |
| Dense or hybrid retrieval fails | Select an embedding profile in the library and index documents with the same embedding model/revision. |
| A PDF says extraction is unsupported | Configure a Tika provider and use parser route \`remote\` or \`auto\`, or use the custom branch. |
| No results | Verify tenant identity, metadata filter, library selection, indexed document count, and query property. Try lexical mode to isolate embedding issues. |
| Citation validation fails | The model must return exact \`[E:evidenceId]\` markers from the supplied evidence; confirm evidence reached the answer node. |
| Conversation is unavailable | Supply both trusted tenant and principal identity and use the same conversation ID before TTL expiry. |
| External vector search is empty | Check the provider URL/credential, library privacy, vector dimensions, and the synchronization error output/log. |
| Destructive operation is rejected | Enable the library policy where applicable, supply boolean confirmation, and disable \`dryRun\` only after reviewing the target. |

For architecture and security rationale, see the [design blueprint](design.md). For release boundaries, see [implementation scope](implementation.md).
`);

fs.writeFileSync('docs/node-user-guide.md',out.join('\n')+'\n');
