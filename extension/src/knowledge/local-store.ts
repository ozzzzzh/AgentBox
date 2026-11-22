import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  KnowledgeChunk,
  SearchResponse,
  Sensitivity,
} from './types';

export interface LocalKnowledgeInput {
  title: string;
  content: string;
  path: string;
  tags?: string[];
  sensitivity?: Sensitivity;
  source?: 'conversation' | 'workspace' | 'manual';
  id?: string;
}

export interface LocalKnowledgeDocument {
  id: string;
  title: string;
  path: string;
  content: string;
  tags: string[];
  sensitivity: Sensitivity;
  source: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

const LOCAL_ID = /^[A-Za-z0-9_-]{1,128}$/;

function localRoot(globalStorage: string): string {
  return join(globalStorage, 'agentbox', 'knowledge', 'local');
}

function docPath(globalStorage: string, id: string): string {
  if (!LOCAL_ID.test(id)) throw new Error('invalid local knowledge id');
  return join(localRoot(globalStorage), `${id}.json`);
}

export function localKnowledgeContentPath(
  globalStorage: string,
  id: string
): string {
  if (!LOCAL_ID.test(id)) throw new Error('invalid local knowledge id');
  return join(localRoot(globalStorage), `${id}.md`);
}

export function localDocumentId(path: string): string {
  return `local_${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 16)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(localRootFromPath(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content, 'utf8');
  try {
    renameSync(temp, path);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST') {
      writeFileSync(path, content, 'utf8');
      try {
        rmSync(temp, { force: true });
      } catch {
        // Best-effort cleanup.
      }
      return;
    }
    throw error;
  }
}

function localRootFromPath(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index < 0 ? '.' : path.slice(0, index);
}

function readDoc(
  globalStorage: string,
  id: string
): LocalKnowledgeDocument | undefined {
  const path = docPath(globalStorage, id);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as LocalKnowledgeDocument;
    if (value.id !== id || typeof value.content !== 'string') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function listLocalKnowledge(
  globalStorage: string
): LocalKnowledgeDocument[] {
  const root = localRoot(globalStorage);
  if (!existsSync(root)) return [];
  const docs: LocalKnowledgeDocument[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    const doc = readDoc(globalStorage, name.slice(0, -'.json'.length));
    if (doc !== undefined) docs.push(doc);
  }
  docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return docs;
}

export function upsertLocalKnowledge(
  globalStorage: string,
  input: LocalKnowledgeInput
): LocalKnowledgeDocument {
  const content = input.content.trim();
  if (content === '') throw new Error('local knowledge content is required');
  const id =
    input.id ??
    `local_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  if (!LOCAL_ID.test(id)) throw new Error('invalid local knowledge id');
  const existing = readDoc(globalStorage, id);
  const now = new Date().toISOString();
  const doc: LocalKnowledgeDocument = {
    id,
    title: input.title.trim() || input.path,
    path: input.path,
    content,
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    sensitivity: input.sensitivity ?? 'internal',
    source: input.source ?? 'conversation',
    contentHash: hash(content),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  mkdirSync(localRoot(globalStorage), { recursive: true });
  atomicWrite(
    localKnowledgeContentPath(globalStorage, id),
    content.endsWith('\n') ? content : `${content}\n`
  );
  atomicWrite(docPath(globalStorage, id), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

export function deleteLocalKnowledge(globalStorage: string, id: string): void {
  for (const path of [docPath(globalStorage, id), localKnowledgeContentPath(globalStorage, id)]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

interface LocalSection {
  heading: string;
  startLine: number;
  endLine: number;
  text: string;
}

function splitSections(content: string): LocalSection[] {
  const lines = content.split('\n');
  const sections: LocalSection[] = [];
  let heading = '';
  let start = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    const text = lines.slice(start, end).join('\n').trim();
    if (text !== '') {
      sections.push({
        heading,
        startLine: start + 1,
        endLine: end,
        text,
      });
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? '');
    if (match !== null) {
      flush(index);
      heading = match[2]!.trim();
      start = index;
    }
  }
  flush(lines.length);
  return sections;
}

function termsOf(query: string): string[] {
  const matches = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const result: string[] = [];
  for (const term of matches) {
    if (!result.includes(term)) result.push(term);
  }
  return result;
}

function countOccurrences(text: string, term: string): number {
  if (term === '') return 0;
  let count = 0;
  let index = 0;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  while ((index = lower.indexOf(needle, index)) >= 0) {
    count += 1;
    index += Math.max(1, needle.length);
  }
  return count;
}

function makeSnippet(text: string, terms: string[], maxChars = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const lower = flat.toLowerCase();
  let hit = -1;
  let term = '';
  for (const candidate of terms) {
    const index = lower.indexOf(candidate.toLowerCase());
    if (index >= 0 && (hit < 0 || index < hit)) {
      hit = index;
      term = candidate;
    }
  }
  const start = hit >= 0 ? Math.max(0, hit - Math.floor(maxChars / 3)) : 0;
  const end = Math.min(flat.length, start + maxChars);
  let snippet = flat.slice(start, end);
  if (hit >= 0 && term !== '') {
    const relative = hit - start;
    if (relative >= 0 && relative + term.length <= snippet.length) {
      snippet =
        snippet.slice(0, relative) +
        '⟦' +
        snippet.slice(relative, relative + term.length) +
        '⟧' +
        snippet.slice(relative + term.length);
    }
  }
  return `${start > 0 ? '…' : ''}${snippet}${end < flat.length ? '…' : ''}`;
}

export function searchLocalKnowledge(
  globalStorage: string,
  options: {
    query: string;
    topK?: number;
    maxChars?: number;
  }
): SearchResponse {
  const started = Date.now();
  const terms = termsOf(options.query);
  const topK = Math.max(1, Math.min(20, Math.trunc(options.topK ?? 5)));
  const maxChars = Math.max(200, Math.trunc(options.maxChars ?? 6_000));
  if (terms.length === 0) {
    return {
      apiVersion: 1,
      mode: 'instr',
      results: [],
      truncated: false,
      warnings: [],
      latencyMs: Date.now() - started,
    };
  }

  const candidates: Array<{ doc: LocalKnowledgeDocument; section: LocalSection; score: number }> = [];
  for (const doc of listLocalKnowledge(globalStorage)) {
    if (doc.sensitivity === 'secret') continue;
    for (const section of splitSections(doc.content)) {
      let score = 0;
      for (const term of terms) {
        score += countOccurrences(section.text, term);
        score += countOccurrences(doc.title, term) * 4;
        score += countOccurrences(section.heading, term) * 3;
        score += countOccurrences(doc.path, term) * 2;
      }
      if (score > 0) candidates.push({ doc, section, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path));

  const results: KnowledgeChunk[] = [];
  const perPath = new Map<string, number>();
  let used = 0;
  let truncated = false;
  for (const candidate of candidates) {
    const count = perPath.get(candidate.doc.path) ?? 0;
    if (count >= 2) continue;
    const text = candidate.section.text;
    if (results.length > 0 && used + text.length > maxChars) {
      truncated = true;
      break;
    }
    perPath.set(candidate.doc.path, count + 1);
    used += text.length;
    results.push({
      chunkId: `local:${candidate.doc.id}:${candidate.section.startLine}`,
      docId: candidate.doc.id,
      path: candidate.doc.path,
      title: candidate.doc.title,
      heading: candidate.section.heading,
      headingPath: candidate.section.heading,
      startLine: candidate.section.startLine,
      endLine: candidate.section.endLine,
      sensitivity: candidate.doc.sensitivity,
      score: candidate.score,
      snippet: makeSnippet(text, terms),
      text,
      charCount: text.length,
      kind: 'markdown',
    });
    if (results.length >= topK) break;
  }

  return {
    apiVersion: 1,
    mode: 'instr',
    results,
    truncated,
    warnings: [],
    latencyMs: Date.now() - started,
  };
}

export interface LocalKnowledgeSummary {
  id: string;
  title: string;
  path: string;
  tags: string[];
  source: string;
  sensitivity: Sensitivity;
  updatedAt: string;
}

export function listLocalKnowledgeSummaries(
  globalStorage: string
): LocalKnowledgeSummary[] {
  return listLocalKnowledge(globalStorage).map((doc) => ({
    id: doc.id,
    title: doc.title,
    path: doc.path,
    tags: doc.tags,
    source: doc.source,
    sensitivity: doc.sensitivity,
    updatedAt: doc.updatedAt,
  }));
}

export function localKnowledgeStatus(globalStorage: string): {
  documents: number;
  chunks: number;
  lastIndexedAt: string | null;
} {
  const docs = listLocalKnowledge(globalStorage);
  return {
    documents: docs.length,
    chunks: docs.reduce((sum, doc) => sum + splitSections(doc.content).length, 0),
    lastIndexedAt: docs[0]?.updatedAt ?? null,
  };
}
