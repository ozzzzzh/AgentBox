/**
 * Public contract for the AgentBox Knowledge Base server.
 *
 * Keep this file free of Node-only imports: the extension mirrors these types
 * in `extension/src/knowledge/types.ts` and both sides must agree.
 */

export const KNOWLEDGE_API_VERSION = 1;
export const KNOWLEDGE_SCHEMA_VERSION = 1;

export const LIMITS = {
  maxBodyBytes: 2 * 1024 * 1024,
  maxDocumentBytes: 1024 * 1024,
  maxDocumentsPerRequest: 20,
  maxRemovedPaths: 5_000,
  maxChunksPerDocument: 500,
  maxChunkChars: 3_200,
  maxChunkLines: 120,
  maxPathChars: 1_024,
  maxQueryChars: 1_024,
  defaultTopK: 5,
  maxTopK: 50,
  defaultMaxChars: 6_000,
  minMaxChars: 500,
  maxMaxChars: 20_000,
} as const;

export type Sensitivity = 'public' | 'internal' | 'secret';
export type DocumentSource = 'workspace' | 'repo' | 'upload' | 'connector';
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

export interface RemovalInput {
  path: string;
}

export interface UpsertDocumentsRequest {
  apiVersion?: number;
  collection: string;
  source?: DocumentSource;
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

export interface UpsertDocumentsResponse {
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

export interface DocumentMetadata {
  id: string;
  collection: string;
  source: DocumentSource;
  path: string;
  title: string | null;
  sensitivity: Sensitivity;
  contentHash: string;
  sizeBytes: number;
  updatedAt: string;
  indexedAt: string;
}

export interface DocumentChunk extends Omit<KnowledgeChunk, 'score' | 'snippet'> {
  ordinal: number;
}

export interface DocumentDetail extends DocumentMetadata {
  chunks?: DocumentChunk[];
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
  fts: {
    tokenizer: 'trigram';
    available: true;
  };
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

export class KnowledgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
