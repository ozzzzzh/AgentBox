# Knowledge Server Contract (v1)

> Status: KB-0/KB-1 implemented.
> This document is the source of truth for the HTTP API, SQLite schema and
> chunk metadata. The extension mirrors these types in
> `extension/src/knowledge/types.ts`.

## 1. Roles

`reader < author < admin`

- `reader`: status, collections, document list/get, search.
- `author`: document batch upsert (including `removedPaths`).
- `admin`: delete, reindex, maintenance, audit.

Tokens come from `KNOWLEDGE_SERVER_TOKENS` (JSON `token -> role`). The server
binds `127.0.0.1` by default. `KNOWLEDGE_SERVER_ALLOW_ANONYMOUS_READER=1` is
only accepted on a loopback bind. Non-loopback deployments must use TLS +
bearer tokens.

## 2. HTTP API

```text
GET    /healthz
GET    /v1/me
GET    /v1/knowledge/status
GET    /v1/knowledge/collections
GET    /v1/knowledge/documents?collection=&limit=&offset=
GET    /v1/knowledge/documents/:id?includeChunks=1
POST   /v1/knowledge/documents
DELETE /v1/knowledge/documents/:id
POST   /v1/knowledge/search
POST   /v1/knowledge/reindex
POST   /v1/knowledge/maintenance
GET    /v1/knowledge/audit?limit=&action=
```

Errors use the same envelope as the Skill server:

```json
{ "error": { "code": "BAD_REQUEST", "message": "..." } }
```

### 2.1 Upsert

```json
{
  "apiVersion": 1,
  "collection": "ws_ab12cd34",
  "source": "workspace",
  "documents": [
    {
      "path": "docs/etl/intern_test.md",
      "title": "intern_test ETL",
      "content": "# ...",
      "sensitivity": "internal",
      "contentHash": "advisory-only",
      "mtimeMs": 1760000000000
    }
  ],
  "removedPaths": ["docs/old.md"],
  "force": false
}
```

- Max 20 documents and 2 MB body per request; max 1 MB per document.
- `removedPaths` is idempotent and processed before upserts.
- Partial success returns HTTP 200 with `errors[]` and `results[]`.
- The server recomputes `content_hash`; `contentHash` is advisory only.
- `source` may be `workspace`, `repo`, `upload`, `connector`, or `conversation`.
  Local capture proposals publish with `source: "conversation"`.
- `sensitivity=secret` and well-known secret file names are skipped.
- Paths are workspace-relative POSIX, with no `..`, no absolute paths and no
  NUL. Backslashes are normalized to `/`.

Response:

```json
{
  "apiVersion": 1,
  "indexed": 2,
  "unchanged": 1,
  "removed": 1,
  "skipped": 0,
  "redactions": 0,
  "errors": [{ "path": "big.bin", "code": "DOC_TOO_LARGE", "message": "..." }],
  "results": []
}
```

### 2.2 Search

```json
{
  "apiVersion": 1,
  "collection": "ws_ab12cd34",
  "query": "intern_test 增量同步",
  "topK": 5,
  "maxChars": 6000,
  "includeText": true,
  "filters": {
    "pathPrefix": "docs/",
    "extensions": [".md", ".sql"],
    "sensitivity": ["internal", "public"]
  }
}
```

```json
{
  "apiVersion": 1,
  "mode": "fts",
  "results": [{
    "chunkId": "c_...",
    "docId": "d_...",
    "path": "docs/etl/intern_test.md",
    "title": "intern_test ETL",
    "heading": "3.2 增量同步",
    "headingPath": "intern_test ETL > 3. 同步 > 3.2 增量同步",
    "startLine": 120,
    "endLine": 168,
    "sensitivity": "internal",
    "score": 0.42,
    "snippet": "...⟦增量同步⟧...",
    "text": "...",
    "charCount": 1840,
    "kind": "markdown"
  }],
  "truncated": false,
  "warnings": [],
  "latencyMs": 12
}
```

- `score` is higher-is-better (server negates SQLite `bm25`).
- `startLine/endLine` are 1-based inclusive on canonical LF text.
- `topK` is clamped to 1–50; `maxChars` to 500–20,000.
- Results are deduplicated by path, at most 2 chunks per document.
- `sensitivity=secret` is never returned.
- Query terms are quoted before `MATCH`; raw query syntax is never passed to
  FTS5. Terms shorter than 3 code points use an `instr` fallback (Chinese
  2-character queries).
- Audit records a query hash and length by default. Set
  `KNOWLEDGE_SERVER_AUDIT_QUERY=raw` for the raw query (development only).

## 3. SQLite schema

```sql
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_indexed_at TEXT
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL REFERENCES collections(id),
  source TEXT NOT NULL DEFAULT 'workspace',
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  title TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'internal'
    CHECK (sensitivity IN ('public','internal','secret')),
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE(collection, path_key)
);

CREATE TABLE chunks (
  chunk_rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  heading_path TEXT NOT NULL DEFAULT '',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  path TEXT NOT NULL,
  text TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  UNIQUE(doc_id, ordinal)
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, heading, path,
  content='chunks',
  content_rowid='chunk_rowid',
  tokenize='trigram'
);
```

Three triggers (`chunks_ai`, `chunks_ad`, `chunks_au`) keep FTS in sync with
`chunks`. `chunk_rowid` is explicit so `VACUUM` cannot desynchronize
external-content FTS. `path_key` is lowercased on Windows and used for
uniqueness; `path` keeps the display/citation spelling.

Each document upsert is a `BEGIN IMMEDIATE` transaction: delete old chunks,
update/insert the document, insert new chunks (triggers update FTS). A bad
document is reported in `errors[]` without rolling back the rest of the batch.

`docId = sha256(collection + NUL + path_key)`, `chunkId = sha256(docId +
':' + ordinal + ':' + content_hash)` with `d_`/`c_` prefixes. Both are stable
for citations.

## 4. Canonicalization and chunking

Before hashing/chunking:

- strip BOM, CRLF/CR → LF, Unicode NFC;
- hash is SHA-256 over the canonical UTF-8 text;
- redact high-confidence secrets (API keys, bearer tokens, passwords,
  connection strings, private keys, AWS keys) before chunking.

Chunk rules:

- Markdown: ATX heading hierarchy; fence-aware (no headings inside ```/~~~);
  max 3,200 chars, max 120 lines; preserve heading and heading path.
- Code: blank-line/declaration blocks, split oversized blocks at line
  boundaries; heading is the nearest declaration line.
- SQL: state machine for quotes/comments/`$tag$`; split at top-level `;`;
  oversized statements split at line boundaries.
- Text: paragraphs, then lines/chars for oversized paragraphs.
- Max 500 chunks per document; truncation is recorded.
- `heading` and `startLine/endLine` are stored on every chunk; `text` is the
  source excerpt with no synthetic heading prefix.

## 5. Environment

```text
PORT=4771
KNOWLEDGE_SERVER_HOSTNAME=127.0.0.1
KNOWLEDGE_SERVER_DATA=./data
KNOWLEDGE_SERVER_TOKENS={"reader-token":"reader","author-token":"author","admin-token":"admin"}
KNOWLEDGE_SERVER_ALLOW_ANONYMOUS_READER=0
KNOWLEDGE_SERVER_AUDIT_QUERY=hash|raw
```

`node:sqlite` is built into Node 24; the server exits with a clear message on
older Node. `knowledge.db-wal` and `knowledge.db-shm` may exist next to the
database; back up `knowledge.db` (and the WAL when copying a live DB).
