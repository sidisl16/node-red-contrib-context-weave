# ContextWeave for Node-RED

[![Build](https://github.com/sidisl16/node-red-contrib-context-weave/actions/workflows/ci.yml/badge.svg?event=pull_request)](https://github.com/sidisl16/node-red-contrib-context-weave/actions/workflows/ci.yml)
[![Quality and coverage](https://github.com/sidisl16/node-red-contrib-context-weave/actions/workflows/quality.yml/badge.svg?event=pull_request)](https://github.com/sidisl16/node-red-contrib-context-weave/actions/workflows/quality.yml)

Connect a data source, index its documents and answer questions with citations. The **context weave** palette includes 34 flow nodes and five reusable configuration nodes. SQLite stores documents, vectors, keyword indexes and conversation history under the Node-RED user directory.

## Try the support flow

1. Use Node.js 24.14+ with SQLite FTS5 support and Node-RED 5.0.10+. From the cloned package directory, run `npm pack`. From your Node-RED user directory, run `npm install /absolute/path/to/node-red-contrib-context-weave-0.1.0.tgz` and restart Node-RED.
2. Start Ollama on the Node-RED host. Run `ollama pull nomic-embed-text` and `ollama pull llama3.2`. The example connects to `http://localhost:11434`.
3. Open **Menu → Import → Examples → node-red-contrib-context-weave → support-rag**, then deploy the flow. You can also import [the flow JSON](examples/support-rag.json) directly.
4. Click **Index sample password-reset article**. When **Index result** appears in Debug, click **Ask about password reset**. The response should cite the article and say that the link expires after 30 minutes.

To use your own data, replace the article Inject node with your connector. In **Map connector record**, select the message properties containing the stable record ID, content and metadata. The example expects `tenant_id` and indexes published records for retrieval.

```text
Connector → source-map → parse-content → record-ingest → split → index
Question  → retrieve → rerank → answer → answer text and citations
```

## Configure models and access

A **provider** stores the service URL and Node-RED credential. A **model-profile** selects the model ID, purpose and privacy policy. Select an embedding profile in the library and a generation profile in the answer node. The local example stores everything on the Node-RED host. To send data to a managed service, explicitly select compatible library and model privacy settings and enter your provider credentials.

For **POST /context-weave/ask**, wire your authenticated identity step before the validation Function and set `msg.auth.tenantId` from that trusted identity. The route returns HTTP 401 when the identity is missing. The Inject nodes use a local example tenant.

## Develop

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run coverage
npm audit --audit-level=high
```

Tests use a local model fixture and a temporary Node-RED instance. Each node has a runtime JS file, editor HTML and help text in `nodes/`. Shared implementations live in `lib/`. Run `node scripts/build-nodes.js` after editing field definitions. CI checks both supported Node.js release lines and enforces a minimum 70% line coverage across library code.

See the [design blueprint](docs/design.md) and [implementation scope](docs/implementation.md) for the node catalogue, configuration and release boundaries. MIT licensed.
