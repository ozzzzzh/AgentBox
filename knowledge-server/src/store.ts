import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  KNOWLEDGE_API_VERSION,
  KNOWLEDGE_SCHEMA_VERSION,
  KnowledgeError,
  LIMITS,
  type AuditEntry,
  type CollectionInfo,
  type DocumentDetail,
  type DocumentInput,
  type DocumentMetadata,
  type KnowledgeChunk,
  type SearchFilters,
  type SearchRequest,
  type SearchResponse,
  type Sensitivity,
  type StatusResponse,
  type UpsertDocumentsRequest,
  type UpsertDocumentsResponse,
} from './contract';
import {
  canonicalizeText,
  chunkDocument,
  contentHash,
  type ChunkDraft,
} from './chunk';
import { isSecretPath, redactText } from './redact';
import { initializeSchema } from './schema';

const COLLECTION = /^[A-Za-z0-9._:-]{1,128}$/;
const SENSITIVITIES = new Set<Sensitivity>(['public', 'internal', 'secret']);

interface DocumentRow {
  id: string;
  collection: string;
  source: string;
  path: string;
  path_key: string;
  title: string | null;
  sensitivity: Sensitivity;
  content_hash: string;
  size_bytes: number;
  updated_at: string;
  indexed_at: string;
}

interface ChunkRow {
  id: string;
  doc_id: string;
  ordinal: number;
  kind: string;
  heading: string;
  heading_path: string;
  start_line: number;
  end_line: number;
  path: string;
  text: string;
  char_count: number;
  token_estimate: number;
}

function now(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function normalizeDocumentPath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new KnowledgeError(400, 'INVALID_PATH', 'path must be a string');
  }
  const raw = value.trim().replace(/\\/g, '/');
  if (raw === '' || raw.includes('\0') || raw.length > LIMITS.maxPathChars) {
    throw new KnowledgeError(400, 'INVALID_PATH', 'invalid document path');
  }
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new KnowledgeError(400, 'INVALID_PATH', 'absolute paths are not allowed');
  }
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new KnowledgeError(400, 'INVALID_PATH', 'path traversal is not allowed');
  }
  const normalized = parts.join('/');
  if (normalized === '') {
    throw new KnowledgeError(400, 'INVALID_PATH', 'invalid document path');
  }
  return normalized;
}

function documentId(collection: string, key: string): string {
  return `d_${sha256(`${collection}\0${key}`).slice(0, 32)}`;
}

function chunkId(docId: string, ordinal: number, hash: string): string {
  return `c_${sha256(`${docId}:${ordinal}:${hash}`).slice(0, 32)}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function quoteFts(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function termsOf(query: string): string[] {
  const matches = query.match(/[\p{L}\p{N}_]+/gu);
  if (matches === null) return [];
  const result: string[] = [];
  for (const term of matches) {
    if (!result.includes(term)) result.push(term);
  }
  return result;
}

function makeSnippet(text: string, terms: string[], maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const lower = flat.toLowerCase();
  let hit = -1;
  let hitTerm = '';
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0 && (hit < 0 || index < hit)) {
      hit = index;
      hitTerm = term;
    }
  }
  let start = hit >= 0 ? Math.max(0, hit - Math.floor(maxChars / 3)) : 0;
  let end = Math.min(flat.length, start + maxChars);
  if (end - start < maxChars && start > 0) {
    start = Math.max(0, end - maxChars);
  }
  let snippet = flat.slice(start, end);
  if (hit >= 0 && hitTerm !== '') {
    const relative = hit - start;
    if (relative >= 0 && relative + hitTerm.length <= snippet.length) {
      snippet =
        snippet.slice(0, relative) +
        '⟦' +
        snippet.slice(relative, relative + hitTerm.length) +
        '⟧' +
        snippet.slice(relative + hitTerm.length);
    }
  }
  return `${start > 0 ? '…' : ''}${snippet}${end < flat.length ? '…' : ''}`;
}

function rowToMetadata(row: DocumentRow): DocumentMetadata {
  return {
    id: row.id,
    collection: row.collection,
    source: row.source as DocumentMetadata['source'],
    path: row.path,
    title: row.title,
    sensitivity: row.sensitivity,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    updatedAt: row.updated_at,
    indexedAt: row.indexed_at,
  };
}

export class KnowledgeStore {
  private readonly db: DatabaseSync;
  private readonly auditFile: string;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'knowledge.db'));
    initializeSchema(this.db);
    this.auditFile = join(dataDir, 'audit.jsonl');
  }

  close(): void {
    this.db.close();
  }

  private audit(entry: AuditEntry): void {
    try {
      appendFileSync(this.auditFile, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Auditing must never break a read request.
    }
  }

  listAudit(limit = 100, action?: string): AuditEntry[] {
    if (!existsSync(this.auditFile)) return [];
    const entries: AuditEntry[] = [];
    for (const line of readFileSync(this.auditFile, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        if (action === undefined || parsed.action === action) entries.push(parsed);
      } catch {
        // Ignore a torn final line.
      }
    }
    return entries.slice(-Math.max(1, Math.min(limit, 1_000))).reverse();
  }

  private ensureCollection(collection: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO collections(id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(collection, collection, timestamp, timestamp);
  }

  private collectionTimestamp(collection: string, timestamp: string): void {
    this.db
      .prepare(
        `UPDATE collections SET updated_at = ?, last_indexed_at = ? WHERE id = ?`
      )
      .run(timestamp, timestamp, collection);
  }

  private removePath(collection: string, path: string): boolean {
    const key = pathKey(path);
    const result = this.db
      .prepare('DELETE FROM documents WHERE collection = ? AND path_key = ?')
      .run(collection, key);
    return Number(result.changes) > 0;
  }

  upsert(request: UpsertDocumentsRequest, actor: string): UpsertDocumentsResponse {
    if (request.apiVersion !== undefined && request.apiVersion !== KNOWLEDGE_API_VERSION) {
      throw new KnowledgeError(400, 'UNSUPPORTED_API_VERSION', 'unsupported apiVersion');
    }
    if (typeof request.collection !== 'string' || !COLLECTION.test(request.collection)) {
      throw new KnowledgeError(400, 'INVALID_COLLECTION', 'invalid collection id');
    }
    if (!Array.isArray(request.documents)) {
      throw new KnowledgeError(400, 'INVALID_DOCUMENTS', 'documents must be an array');
    }
    if (request.documents.length > LIMITS.maxDocumentsPerRequest) {
      throw new KnowledgeError(
        400,
        'TOO_MANY_DOCUMENTS',
        `at most ${LIMITS.maxDocumentsPerRequest} documents per request`
      );
    }
    const removedPaths = request.removedPaths ?? [];
    if (!Array.isArray(removedPaths) || removedPaths.length > LIMITS.maxRemovedPaths) {
      throw new KnowledgeError(400, 'INVALID_REMOVALS', 'invalid removedPaths');
    }

    const source = request.source ?? 'workspace';
    if (!['workspace', 'repo', 'upload', 'connector'].includes(source)) {
      throw new KnowledgeError(400, 'INVALID_SOURCE', 'invalid document source');
    }

    this.ensureCollection(request.collection);
    const timestamp = now();
    let removed = 0;
    const normalizedRemovals = removedPaths.map(normalizeDocumentPath);
    for (const path of normalizedRemovals) {
      if (this.removePath(request.collection, path)) removed += 1;
    }

    const response: UpsertDocumentsResponse = {
      apiVersion: KNOWLEDGE_API_VERSION,
      indexed: 0,
      unchanged: 0,
      removed,
      skipped: 0,
      redactions: 0,
      errors: [],
      results: [],
    };

    for (const input of request.documents) {
      const result = this.upsertDocument(
        request.collection,
        source,
        input,
        request.force === true,
        actor
      );
      response.results.push(result);
      if (result.redactions !== undefined) response.redactions += result.redactions;
      if (result.status === 'indexed') response.indexed += 1;
      else if (result.status === 'unchanged') response.unchanged += 1;
      else if (result.status === 'skipped') response.skipped += 1;
      else if (result.status === 'error') {
        response.errors.push({
          path: result.path,
          code: result.code ?? 'INDEX_ERROR',
          message: result.message ?? 'index failed',
        });
      }
    }
    this.collectionTimestamp(request.collection, timestamp);
    this.audit({
      at: timestamp,
      actor,
      action: 'upsert',
      collection: request.collection,
      detail: `indexed=${response.indexed} unchanged=${response.unchanged} removed=${removed}`,
    });
    return response;
  }

  private upsertDocument(
    collection: string,
    source: string,
    input: DocumentInput,
    force: boolean,
    actor: string
  ): UpsertDocumentsResponse['results'][number] {
    let path = '';
    try {
      path = normalizeDocumentPath(input?.path);
      const sensitivity = SENSITIVITIES.has(input.sensitivity ?? 'internal')
        ? (input.sensitivity ?? 'internal')
        : 'internal';
      if (sensitivity === 'secret' || isSecretPath(path)) {
        // A document may have been indexed before it was marked secret.
        // Remove any existing copy so it cannot remain searchable.
        this.removePath(collection, path);
        this.audit({
          at: now(),
          actor,
          action: 'skip-secret',
          collection,
          path,
        });
        return { path, status: 'skipped', code: 'SECRET_DOCUMENT', message: 'secret documents are not indexed' };
      }
      if (typeof input.content !== 'string') {
        return { path, status: 'error', code: 'INVALID_CONTENT', message: 'content must be a string' };
      }
      const size = Buffer.byteLength(input.content, 'utf8');
      if (size > LIMITS.maxDocumentBytes) {
        return {
          path,
          status: 'error',
          code: 'DOC_TOO_LARGE',
          message: `document exceeds ${LIMITS.maxDocumentBytes} bytes`,
        };
      }

      const canonical = canonicalizeText(input.content);
      const hash = contentHash(canonical);
      const key = pathKey(path);
      const existing = this.db
        .prepare(
          'SELECT * FROM documents WHERE collection = ? AND path_key = ?'
        )
        .get(collection, key) as DocumentRow | undefined;
      if (existing !== undefined && existing.content_hash === hash && !force) {
        return {
          path,
          docId: existing.id,
          status: 'unchanged',
          chunks: Number(
            (
              this.db
                .prepare('SELECT count(*) AS n FROM chunks WHERE doc_id = ?')
                .get(existing.id) as { n: number }
            ).n
          ),
          contentHash: hash,
        };
      }

      const redacted = redactText(canonical);
      const chunked = chunkDocument({
        path,
        content: redacted.text,
        ...(input.language !== undefined ? { language: input.language } : {}),
      });
      if (chunked.chunks.length === 0) {
        if (existing !== undefined) this.removePath(collection, path);
        return { path, status: 'skipped', code: 'EMPTY_DOCUMENT', message: 'document has no indexable text' };
      }

      const id = existing?.id ?? documentId(collection, key);
      const updatedAt =
        typeof input.mtimeMs === 'number' && Number.isFinite(input.mtimeMs)
          ? new Date(input.mtimeMs).toISOString()
          : now();
      const indexedAt = now();
      const title =
        input.title?.trim() ||
        chunked.chunks[0]?.heading ||
        path.split('/').pop() ||
        path;

      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (existing !== undefined) {
          this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
          this.db
            .prepare(
              `UPDATE documents SET source = ?, path = ?, title = ?,
                 sensitivity = ?, content_hash = ?, size_bytes = ?,
                 updated_at = ?, indexed_at = ?
               WHERE id = ?`
            )
            .run(
              source,
              path,
              title,
              sensitivity,
              hash,
              size,
              updatedAt,
              indexedAt,
              id
            );
        } else {
          this.db
            .prepare(
              `INSERT INTO documents(id, collection, source, path, path_key,
                 title, sensitivity, content_hash, size_bytes, updated_at, indexed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              id,
              collection,
              source,
              path,
              key,
              title,
              sensitivity,
              hash,
              size,
              updatedAt,
              indexedAt
            );
        }
        const insertChunk = this.db.prepare(
          `INSERT INTO chunks(id, doc_id, ordinal, kind, heading, heading_path,
             start_line, end_line, path, text, char_count, token_estimate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        chunked.chunks.forEach((chunk: ChunkDraft, ordinal: number) => {
          insertChunk.run(
            chunkId(id, ordinal, hash),
            id,
            ordinal,
            chunk.kind,
            chunk.heading,
            chunk.headingPath,
            chunk.startLine,
            chunk.endLine,
            path,
            chunk.text,
            chunk.charCount,
            chunk.tokenEstimate
          );
        });
        this.db.exec('COMMIT');
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw error;
      }

      return {
        path,
        docId: id,
        status: 'indexed',
        chunks: chunked.chunks.length,
        redactions: redacted.count,
        contentHash: hash,
      };
    } catch (error) {
      return {
        path,
        status: 'error',
        code: 'INDEX_ERROR',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  listDocuments(
    collection: string,
    limit = 500,
    offset = 0
  ): { documents: DocumentMetadata[]; total: number } {
    if (!COLLECTION.test(collection)) {
      throw new KnowledgeError(400, 'INVALID_COLLECTION', 'invalid collection id');
    }
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    const rows = this.db
      .prepare(
        `SELECT * FROM documents WHERE collection = ?
         ORDER BY path ASC LIMIT ? OFFSET ?`
      )
      .all(collection, safeLimit, safeOffset) as unknown as DocumentRow[];
    const total = Number(
      (
        this.db
          .prepare('SELECT count(*) AS n FROM documents WHERE collection = ?')
          .get(collection) as { n: number }
      ).n
    );
    return { documents: rows.map(rowToMetadata), total };
  }

  getDocument(id: string, includeChunks = false): DocumentDetail | undefined {
    const row = this.db
      .prepare('SELECT * FROM documents WHERE id = ?')
      .get(id) as DocumentRow | undefined;
    if (row === undefined) return undefined;
    const detail: DocumentDetail = rowToMetadata(row);
    if (includeChunks) {
      const rows = this.db
        .prepare('SELECT * FROM chunks WHERE doc_id = ? ORDER BY ordinal ASC LIMIT 500')
        .all(id) as unknown as ChunkRow[];
      detail.chunks = rows.map((chunk) => ({
        chunkId: chunk.id,
        docId: chunk.doc_id,
        ordinal: chunk.ordinal,
        path: chunk.path,
        title: row.title,
        heading: chunk.heading,
        headingPath: chunk.heading_path,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        sensitivity: row.sensitivity,
        charCount: chunk.char_count,
        kind: chunk.kind as KnowledgeChunk['kind'],
      }));
    }
    return detail;
  }

  deleteDocument(id: string, actor: string): boolean {
    const row = this.db
      .prepare('SELECT collection, path FROM documents WHERE id = ?')
      .get(id) as { collection: string; path: string } | undefined;
    if (row === undefined) return false;
    const result = this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    this.audit({
      at: now(),
      actor,
      action: 'delete',
      collection: row.collection,
      path: row.path,
    });
    return Number(result.changes) > 0;
  }

  status(): StatusResponse {
    const documents = Number(
      (this.db.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }).n
    );
    const chunks = Number(
      (this.db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n
    );
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.last_indexed_at,
           (SELECT count(*) FROM documents d WHERE d.collection = c.id) AS documents,
           (SELECT count(*) FROM chunks ch JOIN documents d ON d.id = ch.doc_id
             WHERE d.collection = c.id) AS chunks
         FROM collections c ORDER BY c.id ASC`
      )
      .all() as Array<{
        id: string;
        name: string;
        last_indexed_at: string | null;
        documents: number;
        chunks: number;
      }>;
    const last = this.db
      .prepare('SELECT max(indexed_at) AS at FROM documents')
      .get() as { at: string | null };
    let dbBytes = 0;
    for (const name of ['knowledge.db', 'knowledge.db-wal', 'knowledge.db-shm']) {
      const file = join(this.dataDir, name);
      if (existsSync(file)) dbBytes += statSync(file).size;
    }
    const collections: CollectionInfo[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      documents: Number(row.documents),
      chunks: Number(row.chunks),
      lastIndexedAt: row.last_indexed_at,
    }));
    return {
      apiVersion: KNOWLEDGE_API_VERSION,
      ok: true,
      service: 'agentbox-knowledge',
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      documents,
      chunks,
      collections,
      lastIndexedAt: last.at,
      dbBytes,
      fts: { tokenizer: 'trigram', available: true },
    };
  }

  search(request: SearchRequest, actor: string): SearchResponse {
    const started = Date.now();
    if (request.apiVersion !== undefined && request.apiVersion !== KNOWLEDGE_API_VERSION) {
      throw new KnowledgeError(400, 'UNSUPPORTED_API_VERSION', 'unsupported apiVersion');
    }
    if (typeof request.collection !== 'string' || !COLLECTION.test(request.collection)) {
      throw new KnowledgeError(400, 'INVALID_COLLECTION', 'invalid collection id');
    }
    if (typeof request.query !== 'string' || request.query.trim() === '') {
      throw new KnowledgeError(400, 'QUERY_REQUIRED', 'query is required');
    }
    if (request.query.length > LIMITS.maxQueryChars) {
      throw new KnowledgeError(400, 'QUERY_TOO_LONG', 'query is too long');
    }
    const query = request.query.trim();
    const topK = Math.max(
      1,
      Math.min(LIMITS.maxTopK, Math.trunc(request.topK ?? LIMITS.defaultTopK))
    );
    const maxChars = Math.max(
      LIMITS.minMaxChars,
      Math.min(
        LIMITS.maxMaxChars,
        Math.trunc(request.maxChars ?? LIMITS.defaultMaxChars)
      )
    );
    const includeText = request.includeText !== false;
    const terms = termsOf(query);
    if (terms.length === 0) {
      throw new KnowledgeError(400, 'QUERY_REQUIRED', 'query has no searchable terms');
    }

    const filters = request.filters ?? {};
    if (
      filters.pathPrefix !== undefined &&
      typeof filters.pathPrefix !== 'string'
    ) {
      throw new KnowledgeError(400, 'INVALID_FILTER', 'pathPrefix must be a string');
    }
    if (
      filters.sensitivity !== undefined &&
      !Array.isArray(filters.sensitivity)
    ) {
      throw new KnowledgeError(400, 'INVALID_FILTER', 'sensitivity must be an array');
    }
    if (
      filters.extensions !== undefined &&
      !Array.isArray(filters.extensions)
    ) {
      throw new KnowledgeError(400, 'INVALID_FILTER', 'extensions must be an array');
    }
    const where: string[] = ['d.collection = ?'];
    const params: Array<string | number> = [request.collection];
    if (filters.sensitivity !== undefined && filters.sensitivity.length > 0) {
      const allowed = filters.sensitivity.filter(
        (item) => SENSITIVITIES.has(item) && item !== 'secret'
      );
      if (allowed.length === 0) {
        throw new KnowledgeError(400, 'INVALID_FILTER', 'invalid sensitivity filter');
      }
      where.push(`d.sensitivity IN (${allowed.map(() => '?').join(', ')})`);
      params.push(...allowed);
    } else {
      where.push("d.sensitivity <> 'secret'");
    }
    if (filters.pathPrefix !== undefined && filters.pathPrefix.trim() !== '') {
      const prefix = normalizeDocumentPath(filters.pathPrefix);
      where.push("d.path LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(prefix.endsWith('/') ? prefix : `${prefix}/`)}%`);
    }
    if (filters.extensions !== undefined && filters.extensions.length > 0) {
      const extensions = filters.extensions
        .map((item) => item.trim().toLowerCase())
        .filter((item) => /^\.[a-z0-9]+$/.test(item));
      if (extensions.length !== filters.extensions.length) {
        throw new KnowledgeError(400, 'INVALID_FILTER', 'invalid extension filter');
      }
      where.push(
        `(${extensions.map(() => 'd.path LIKE ?').join(' OR ')})`
      );
      params.push(...extensions.map((ext) => `%${ext}`));
    }

    const ftsTerms = terms.filter((term) => [...term].length >= 3);
    const shortTerms = terms.filter((term) => [...term].length < 3);
    let rows: Array<Record<string, unknown>> = [];
    let mode: 'fts' | 'instr' = 'fts';

    const runFts = (match: string): Array<Record<string, unknown>> => {
      const sqlWhere = [...where, 'chunks_fts MATCH ?'];
      const sqlParams = [...params, match];
      for (const term of shortTerms) {
        sqlWhere.push('instr(lower(c.text), lower(?)) > 0');
        sqlParams.push(term);
      }
      const sql = `
        SELECT c.id AS chunk_id, c.doc_id, c.ordinal, c.kind, c.heading,
               c.heading_path, c.start_line, c.end_line, c.text, c.char_count,
               d.path, d.title, d.sensitivity,
               bm25(chunks_fts, 1.0, 2.0, 0.3) AS bm25_score
        FROM chunks_fts
        JOIN chunks c ON c.chunk_rowid = chunks_fts.rowid
        JOIN documents d ON d.id = c.doc_id
        WHERE ${sqlWhere.join(' AND ')}
        ORDER BY bm25_score ASC
        LIMIT ?`;
      return this.db.prepare(sql).all(...sqlParams, topK * 3) as Array<
        Record<string, unknown>
      >;
    };

    if (ftsTerms.length > 0) {
      const andMatch = ftsTerms.map(quoteFts).join(' AND ');
      rows = runFts(andMatch);
      if (rows.length === 0 && ftsTerms.length > 1) {
        rows = runFts(ftsTerms.map(quoteFts).join(' OR '));
      }
    } else {
      mode = 'instr';
    }

    if (rows.length === 0) {
      mode = 'instr';
      const sqlWhere = [...where];
      const sqlParams = [...params];
      for (const term of terms) {
        sqlWhere.push(
          '(instr(lower(c.text), lower(?)) > 0 OR instr(lower(c.heading), lower(?)) > 0)'
        );
        sqlParams.push(term, term);
      }
      const sql = `
        SELECT c.id AS chunk_id, c.doc_id, c.ordinal, c.kind, c.heading,
               c.heading_path, c.start_line, c.end_line, c.text, c.char_count,
               d.path, d.title, d.sensitivity,
               0 AS bm25_score
        FROM chunks c
        JOIN documents d ON d.id = c.doc_id
        WHERE ${sqlWhere.join(' AND ')}
        ORDER BY c.ordinal ASC
        LIMIT ?`;
      rows = this.db.prepare(sql).all(...sqlParams, topK * 3) as Array<
        Record<string, unknown>
      >;
    }

    const results: KnowledgeChunk[] = [];
    const perPath = new Map<string, number>();
    let usedChars = 0;
    let truncated = false;
    for (const row of rows) {
      const path = String(row.path);
      const count = perPath.get(path) ?? 0;
      if (count >= 2) continue;
      const charCount = Number(row.char_count);
      if (results.length > 0 && usedChars + charCount > maxChars) {
        truncated = true;
        break;
      }
      perPath.set(path, count + 1);
      usedChars += charCount;
      const text = String(row.text);
      results.push({
        chunkId: String(row.chunk_id),
        docId: String(row.doc_id),
        path,
        title: row.title === null ? null : String(row.title),
        heading: String(row.heading),
        headingPath: String(row.heading_path),
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        sensitivity: row.sensitivity as Sensitivity,
        score: -Number(row.bm25_score ?? 0),
        snippet: makeSnippet(text, terms, 240),
        ...(includeText ? { text } : {}),
        charCount,
        kind: String(row.kind) as KnowledgeChunk['kind'],
      });
      if (results.length >= topK) break;
    }

    const latencyMs = Date.now() - started;
    this.audit({
      at: now(),
      actor,
      action: 'search',
      collection: request.collection,
      queryHash: sha256(query).slice(0, 16),
      queryLength: query.length,
      topK,
      resultCount: results.length,
      durationMs: latencyMs,
      ...(process.env.KNOWLEDGE_SERVER_AUDIT_QUERY === 'raw'
        ? { detail: query.slice(0, 200) }
        : {}),
    });
    return {
      apiVersion: KNOWLEDGE_API_VERSION,
      mode,
      results,
      truncated,
      warnings: truncated ? [`results truncated to ${maxChars} chars`] : [],
      latencyMs,
    };
  }

  maintenance(action: string): { ok: true; action: string; detail?: string } {
    if (action === 'optimize') {
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
      this.db.exec('PRAGMA optimize');
      return { ok: true, action };
    }
    if (action === 'integrity-check') {
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
      const row = this.db.prepare('PRAGMA integrity_check').get() as
        | { integrity_check: string }
        | undefined;
      return { ok: true, action, detail: row?.integrity_check ?? 'ok' };
    }
    if (action === 'vacuum') {
      this.db.exec('VACUUM');
      return { ok: true, action };
    }
    throw new KnowledgeError(400, 'INVALID_MAINTENANCE', 'invalid maintenance action');
  }

  reindex(): { ok: true; documents: number; chunks: number } {
    this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
    const status = this.status();
    return { ok: true, documents: status.documents, chunks: status.chunks };
  }
}
