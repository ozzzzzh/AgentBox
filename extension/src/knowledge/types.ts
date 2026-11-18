/** Types mirrored from knowledge-server/src/contract.ts. */

export type Sensitivity = 'public' | 'internal' | 'secret';
export type ChunkKind = 'markdown' | 'code' | 'sql' | 'text';

export interface DocumentInput {
  path: string;
  content: string;
  title?: string;
  language?: string;
  sensitivity?: Sensitivity;
  contentHash?: string;
  mtimeMs?: number;
}

export interface UpsertRequest {
  apiVersion?: number;
  collection: string;
  source?: 'workspace' | 'repo' | 'upload' | 'connector';
  documents: DocumentInput[];
  removedPaths?: string[];
  force?: boolean;
}

export interface DocumentResult {
  path: string;
  docId?: string;
  status: 'indexed' | 'unchanged' | 'skipped' | 'error';
  chunks?: number;
  redactions?: number;
  contentHash?: string;
  code?: string;
  message?: string;
}

export interface UpsertResponse {
  apiVersion: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  redactions: number;
  errors: Array<{ path: string; code: string; message: string }>;
  results: DocumentResult[];
}

export interface SearchFilters {
  pathPrefix?: string;
  extensions?: string[];
  sensitivity?: Sensitivity[];
}

export interface SearchRequest {
  apiVersion?: number;
  collection: string;
  query: string;
  topK?: number;
  maxChars?: number;
  includeText?: boolean;
  filters?: SearchFilters;
}

export interface KnowledgeChunk {
  chunkId: string;
  docId: string;
  path: string;
  title: string | null;
  heading: string;
  headingPath: string;
  startLine: number;
  endLine: number;
  sensitivity: Sensitivity;
  score: number;
  snippet: string;
  text?: string;
  charCount: number;
  kind: ChunkKind;
}

export interface SearchResponse {
  apiVersion: number;
  mode: 'fts' | 'instr';
  results: KnowledgeChunk[];
  truncated: boolean;
  warnings: string[];
  latencyMs: number;
}

export interface KnowledgeCitation {
  /** K1, K2… assigned in injection order. */
  id: string;
  chunkId: string;
  docId: string;
  path: string;
  title: string | null;
  heading: string;
  headingPath: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface KnowledgeTurnInfo {
  citations: KnowledgeCitation[];
  chars: number;
  truncated: boolean;
}

export interface DocumentMetadata {
  id: string;
  collection: string;
  source: string;
  path: string;
  title: string | null;
  sensitivity: Sensitivity;
  contentHash: string;
  sizeBytes: number;
  updatedAt: string;
  indexedAt: string;
}

export interface DocumentListResponse {
  documents: DocumentMetadata[];
  total: number;
}

export interface CollectionInfo {
  id: string;
  name: string;
  documents: number;
  chunks: number;
  lastIndexedAt: string | null;
}

export interface StatusResponse {
  apiVersion: number;
  ok: true;
  service: 'agentbox-knowledge';
  schemaVersion: number;
  documents: number;
  chunks: number;
  collections: CollectionInfo[];
  lastIndexedAt: string | null;
  dbBytes: number;
  fts: { tokenizer: 'trigram'; available: true };
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  collection?: string;
  path?: string;
  queryHash?: string;
  queryLength?: number;
  topK?: number;
  resultCount?: number;
  durationMs?: number;
  detail?: string;
}
