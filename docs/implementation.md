# Implementation scope

This release registers every named node in the design catalogue. Use the settings visible in each node's editor for this version. The design document also describes future adapters and service-level features.

| Area | Implemented choice and boundary |
| --- | --- |
| Knowledge storage | Libraries use SQLite, Qdrant, pgvector or Chroma for dense search. SQLite retains a durable copy of vectors, source records, search filters, keyword indexes and the remote synchronization log. Filtered candidate IDs are sent in batches of 256. Benchmark large collections with representative filters. |
| Source connectors | User-owned Node-RED source nodes feed the mapper. Built-in parsing handles structured records, HTML, Markdown and text. Connect a Tika service for binary document text extraction or wire a custom parser. Table and image artifacts require a custom parser. |
| Chunking | The token window uses a whitespace-based size estimate. Locators preserve section-relative text offsets. |
| Generation | HTTP adapters support OpenAI, compatible services, Claude, Gemini and Ollama. Use a generation-capable model and its matching endpoint. CI exercises fixture responses and a real local HTTP transport. |
| Permissions | Supply a trusted identity upstream and restrict editor access to trusted flow authors. Tenant policies isolate local data. Indexing rejects documents with unsupported fine-grained ACLs. |
| Operations | Back up the Node-RED user directory and SQLite databases using a consistent snapshot. The release does not ship distributed transactions, metered billing, a retention scheduler, or an external audit backend. |
| Sessions | SQLite or bounded in-memory sessions. The agent tool bridge operates within one Node-RED process. |
| Dependency review | PostgreSQL uses the MIT-licensed pg driver. The REST adapters use Node.js fetch. The build audits the full npm lockfile for high and critical advisories. |

The support example is [examples/support-rag.json](../examples/support-rag.json).
