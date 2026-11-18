import type { DatabaseSync } from 'node:sqlite';
import { KNOWLEDGE_SCHEMA_VERSION } from './contract';

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
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

CREATE TABLE IF NOT EXISTS chunks (
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

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  heading,
  path,
  content='chunks',
  content_rowid='chunk_rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading, path)
  VALUES (new.chunk_rowid, new.text, new.heading, new.path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading, path)
  VALUES ('delete', old.chunk_rowid, old.text, old.heading, old.path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading, path)
  VALUES ('delete', old.chunk_rowid, old.text, old.heading, old.path);
  INSERT INTO chunks_fts(rowid, text, heading, path)
  VALUES (new.chunk_rowid, new.text, new.heading, new.path);
END;

CREATE INDEX IF NOT EXISTS documents_collection_idx
  ON documents(collection, path_key);
CREATE INDEX IF NOT EXISTS chunks_doc_idx
  ON chunks(doc_id, ordinal);
`;

export function initializeSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(DDL);

  const row = db
    .prepare('SELECT value FROM schema_meta WHERE key = ?')
    .get('schema_version') as { value?: string } | undefined;
  if (row?.value === undefined) {
    db.prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      String(KNOWLEDGE_SCHEMA_VERSION)
    );
    return;
  }
  if (row.value !== String(KNOWLEDGE_SCHEMA_VERSION)) {
    throw new Error(
      `unsupported knowledge schema version ${row.value}; expected ${KNOWLEDGE_SCHEMA_VERSION}`
    );
  }
}
