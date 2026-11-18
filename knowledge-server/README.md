# AgentBox Knowledge Server

Local/intranet knowledge base for AgentBox. Indexes workspace documents,
chunks them server-side, stores them in SQLite FTS5 (trigram), and returns
top-k chunks with path/heading/line citations.

- Node **24+** (built-in `node:sqlite`, no native dependency)
- Default bind `127.0.0.1:4771`
- Default data directory `./data`; dev uses `.knowledge-data/`
- Contract: [docs/CONTRACT.md](docs/CONTRACT.md)

## Quick start

```powershell
cd knowledge-server
npm install
npm run dev
```

`npm run dev` prints:

```text
dev-reader -> reader
dev-author -> author
dev-admin  -> admin
anonymous loopback reader is enabled
```

Then configure the extension:

```json
{
  "agentbox.knowledge.serverUrl": "http://127.0.0.1:4771",
  "agentbox.knowledge.autoRetrieve": true
}
```

Run **AgentBox: Reindex Knowledge** once, then **AgentBox: Search Knowledge**.

## Production-style run

```powershell
$env:PORT = "4771"
$env:KNOWLEDGE_SERVER_HOSTNAME = "127.0.0.1"
$env:KNOWLEDGE_SERVER_DATA = "D:\agentbox-knowledge-data"
$env:KNOWLEDGE_SERVER_TOKENS = '{"my-reader":"reader","my-author":"author","my-admin":"admin"}'
npm start
```

The extension stores the token in VS Code SecretStorage through
**AgentBox: Set Knowledge Server Token**. Never put it in `settings.json`.
For a non-loopback bind, use TLS (reverse proxy) and set tokens; anonymous
reader is rejected outside loopback.

## API examples

> Windows `curl.exe -d` may use the console code page; use a UTF-8 JSON file with
> `--data-binary @file.json` when the body contains Chinese. The extension host
> uses `fetch` with UTF-8 and does not have this issue.

```powershell
$base = "http://127.0.0.1:4771"

curl.exe -sS "$base/healthz"

curl.exe -sS -X POST "$base/v1/knowledge/documents" `
  -H "authorization: Bearer dev-author" `
  -H "content-type: application/json" `
  -d '{\"collection\":\"ws_demo\",\"documents\":[{\"path\":\"docs/a.md\",\"content\":\"# A\\n\\n增量同步逻辑\"}]}'

curl.exe -sS -X POST "$base/v1/knowledge/search" `
  -H "authorization: Bearer dev-reader" `
  -H "content-type: application/json" `
  -d '{\"collection\":\"ws_demo\",\"query\":\"增量同步\",\"topK\":5}'
```

## Storage

```text
KNOWLEDGE_SERVER_DATA/
  knowledge.db
  knowledge.db-wal
  knowledge.db-shm
  audit.jsonl
```

`audit.jsonl` stores operation metadata; by default search queries are hashed
(`KNOWLEDGE_SERVER_AUDIT_QUERY=raw` enables raw query logging for local debug).

## Security notes

- Indexing sends workspace content to this server. Keep `serverUrl` empty
  unless the server is trusted; loopback is the default.
- Auto-retrieve sends the user prompt (and a short file/selection hint) to the
  server. A remote server sees prompts; document this before team deployment.
- `collection` + token roles isolate workspaces, but there is no per-collection
  ACL in this MVP. Do not expose a shared server to a team until ACL lands.
- Secret files (`.env`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`,
  `secrets*`) are skipped by the extension and `sensitivity=secret` documents
  are rejected by the server. Redaction is best-effort, not a guarantee.
- Knowledge chunks are reference data, not instructions. The extension wraps
  them in `<knowledge>` and keeps `developerInstructions`/skills higher
  priority.

## Tests

```powershell
npm test
```

Tests use the real HTTP server and a temporary data directory; no external
network or LLM is required.
