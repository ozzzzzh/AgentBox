import { createHash } from 'node:crypto';
import { LIMITS, type ChunkKind } from './contract';

export interface ChunkDraft {
  kind: ChunkKind;
  heading: string;
  headingPath: string;
  startLine: number;
  endLine: number;
  text: string;
  charCount: number;
  tokenEstimate: number;
}

export interface ChunkDocumentResult {
  canonicalText: string;
  kind: ChunkKind;
  chunks: ChunkDraft[];
  truncated: boolean;
}

interface RawRange {
  start: number;
  end: number;
  heading: string;
  headingPath: string;
}

export function canonicalizeText(input: string): string {
  return input
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC');
}

export function contentHash(canonicalText: string): string {
  return createHash('sha256').update(canonicalText, 'utf8').digest('hex');
}

export function estimateTokens(text: string): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      units += 1;
    } else {
      units += 0.25;
    }
  }
  return Math.max(1, Math.ceil(units));
}

export function detectChunkKind(path: string, language?: string): ChunkKind {
  const lang = language?.toLowerCase() ?? '';
  if (lang === 'markdown' || lang === 'md' || lang === 'mdx') return 'markdown';
  if (lang === 'sql') return 'sql';
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (ext === 'md' || ext === 'mdx') return 'markdown';
  if (ext === 'sql') return 'sql';
  if (
    [
      'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rs', 'cs',
      'c', 'h', 'cpp', 'hpp', 'rb', 'php', 'swift', 'kt', 'kts', 'scala',
      'sh', 'ps1', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg',
      'conf', 'xml', 'html', 'css', 'scss', 'vue', 'svelte',
    ].includes(ext)
  ) {
    return 'code';
  }
  return 'text';
}

class LineIndex {
  readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  lineAt(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.starts[mid]! <= offset) low = mid + 1;
      else high = mid - 1;
    }
    return Math.max(1, high + 1);
  }

  lineEnd(index: number): number {
    return index + 1 < this.starts.length
      ? this.starts[index + 1]!
      : this.text.length;
  }
}

function trimNewlines(
  text: string,
  start: number,
  end: number
): { start: number; end: number } {
  while (start < end && text[start] === '\n') start += 1;
  while (end > start && text[end - 1] === '\n') end -= 1;
  return { start, end };
}

function splitCharRange(
  text: string,
  start: number,
  end: number,
  maxChars: number
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = start;
  while (cursor < end) {
    let next = Math.min(end, cursor + Math.max(1, maxChars));
    if (
      next < end &&
      next > cursor + 1 &&
      text.charCodeAt(next - 1) >= 0xd800 &&
      text.charCodeAt(next - 1) <= 0xdbff
    ) {
      next -= 1;
    }
    ranges.push({ start: cursor, end: next });
    cursor = next;
  }
  return ranges;
}

function splitRangeByLines(
  text: string,
  index: LineIndex,
  start: number,
  end: number,
  maxChars = LIMITS.maxChunkChars,
  maxLines = LIMITS.maxChunkLines
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = start;
  let line = index.lineAt(start);
  let linesInChunk = 0;
  let chunkStart = start;

  while (cursor < end) {
    const lineEnd = Math.min(end, index.lineEnd(line - 1));
    const nextLine = line + 1;
    const lineLength = lineEnd - cursor;
    const wouldExceed =
      lineLength > 0 &&
      (lineEnd - chunkStart > maxChars || linesInChunk >= maxLines);

    if (wouldExceed && lineEnd > chunkStart) {
      ranges.push({ start: chunkStart, end: cursor });
      chunkStart = cursor;
      linesInChunk = 0;
    }

    if (lineLength > maxChars) {
      ranges.push(...splitCharRange(text, cursor, lineEnd, maxChars));
      cursor = lineEnd;
      chunkStart = cursor;
      linesInChunk = 0;
    } else {
      cursor = lineEnd;
      linesInChunk += 1;
    }
    line = nextLine;
  }

  if (chunkStart < end) ranges.push({ start: chunkStart, end });
  return ranges;
}

function packBlocks(
  text: string,
  index: LineIndex,
  blocks: Array<{ start: number; end: number }>,
  heading: string,
  headingPath: string,
  maxChars = LIMITS.maxChunkChars
): RawRange[] {
  const ranges: RawRange[] = [];
  let current: { start: number; end: number } | null = null;

  const flush = (): void => {
    if (current !== null) {
      ranges.push({ ...current, heading, headingPath });
      current = null;
    }
  };

  for (const block of blocks) {
    const trimmed = trimNewlines(text, block.start, block.end);
    if (trimmed.start >= trimmed.end) continue;
    if (trimmed.end - trimmed.start > maxChars) {
      flush();
      for (const part of splitRangeByLines(
        text,
        index,
        trimmed.start,
        trimmed.end
      )) {
        ranges.push({ ...part, heading, headingPath });
      }
      continue;
    }
    if (
      current !== null &&
      trimmed.end - current.start > maxChars
    ) {
      flush();
    }
    current =
      current === null
        ? { start: trimmed.start, end: trimmed.end }
        : { start: current.start, end: trimmed.end };
  }
  flush();
  return ranges;
}

interface MarkdownSection {
  start: number;
  end: number;
  heading: string;
  headingPath: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function markdownSections(
  text: string,
  index: LineIndex
): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let sectionStart = 0;
  let heading = '';
  let headingPath = '';
  let fence: { char: string; length: number } | null = null;

  const pushSection = (end: number): void => {
    const trimmed = trimNewlines(text, sectionStart, end);
    if (trimmed.start < trimmed.end) {
      sections.push({
        start: trimmed.start,
        end: trimmed.end,
        heading,
        headingPath,
      });
    }
  };

  for (let line = 0; line < index.starts.length; line += 1) {
    const start = index.starts[line]!;
    if (start >= text.length) break;
    const end = index.lineEnd(line);
    const raw = text.slice(start, end).replace(/\n$/, '');
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence === null && fenceMatch !== null) {
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    if (
      fence !== null &&
      fenceMatch !== null &&
      fenceMatch[1]![0] === fence.char &&
      fenceMatch[1]!.length >= fence.length
    ) {
      fence = null;
      continue;
    }
    if (fence !== null) continue;

    const match = HEADING.exec(raw);
    if (match === null) continue;
    pushSection(start);
    const level = match[1]!.length;
    const title = match[2]!.trim();
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
      stack.pop();
    }
    stack.push({ level, text: title });
    heading = title;
    headingPath = stack.map((item) => item.text).join(' > ');
    sectionStart = start;
  }
  pushSection(text.length);
  return sections;
}

function chunkMarkdown(text: string, index: LineIndex): RawRange[] {
  const result: RawRange[] = [];
  for (const section of markdownSections(text, index)) {
    if (section.end - section.start <= LIMITS.maxChunkChars) {
      const trimmed = trimNewlines(text, section.start, section.end);
      if (trimmed.start < trimmed.end) {
        result.push({
          ...trimmed,
          heading: section.heading,
          headingPath: section.headingPath,
        });
      }
      continue;
    }
    for (const range of splitRangeByLines(
      text,
      index,
      section.start,
      section.end
    )) {
      result.push({
        ...range,
        heading: section.heading,
        headingPath: section.headingPath,
      });
    }
  }
  return result;
}

const DECLARATION =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|impl|public|private|protected|static|module|namespace|using|package)\b/;

function chunkCode(text: string, index: LineIndex): RawRange[] {
  if (text.length <= LIMITS.maxChunkChars) return [{ start: 0, end: text.length, heading: '', headingPath: '' }];

  const blocks: Array<{ start: number; end: number; heading: string }> = [];
  let blockStart = 0;
  let heading = '';
  for (let line = 0; line < index.starts.length; line += 1) {
    const start = index.starts[line]!;
    const end = index.lineEnd(line);
    const raw = text.slice(start, end).replace(/\n$/, '');
    const isBlank = raw.trim() === '';
    if (isBlank) {
      if (blockStart < start) {
        blocks.push({ start: blockStart, end: start, heading });
      }
      blockStart = end;
      heading = '';
      continue;
    }
    if (DECLARATION.test(raw) && heading === '') {
      heading = raw.trim().slice(0, 80);
    }
  }
  if (blockStart < text.length) {
    blocks.push({ start: blockStart, end: text.length, heading });
  }

  const result: RawRange[] = [];
  let current: { start: number; end: number; heading: string } | null = null;
  const flush = (): void => {
    if (current !== null) {
      result.push({
        start: current.start,
        end: current.end,
        heading: current.heading,
        headingPath: current.heading,
      });
      current = null;
    }
  };
  for (const block of blocks) {
    const trimmed = trimNewlines(text, block.start, block.end);
    if (trimmed.start >= trimmed.end) continue;
    if (trimmed.end - trimmed.start > LIMITS.maxChunkChars) {
      flush();
      for (const part of splitRangeByLines(
        text,
        index,
        trimmed.start,
        trimmed.end
      )) {
        result.push({
          ...part,
          heading: block.heading,
          headingPath: block.heading,
        });
      }
      continue;
    }
    if (
      current !== null &&
      trimmed.end - current.start > LIMITS.maxChunkChars
    ) {
      flush();
    }
    current =
      current === null
        ? { start: trimmed.start, end: trimmed.end, heading: block.heading }
        : { start: current.start, end: trimmed.end, heading: current.heading };
  }
  flush();
  return result;
}

interface SqlStatement {
  start: number;
  end: number;
}

function sqlStatements(text: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let statementStart = 0;
  let state:
    | 'normal'
    | 'single'
    | 'double'
    | 'line-comment'
    | 'block-comment'
    | 'dollar' = 'normal';
  let depth = 0;
  let dollarTag = '';

  const push = (end: number): void => {
    let start = statementStart;
    while (start < end && /\s/.test(text[start]!)) start += 1;
    if (start < end) statements.push({ start, end });
    statementStart = end + 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const next = text[i + 1];
    if (state === 'line-comment') {
      if (char === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'normal';
        i += 1;
      }
      continue;
    }
    if (state === 'single') {
      if (char === "'" && next === "'") {
        i += 1;
      } else if (char === "'") {
        state = 'normal';
      }
      continue;
    }
    if (state === 'double') {
      if (char === '"' && next === '"') {
        i += 1;
      } else if (char === '"') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'dollar') {
      if (text.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        state = 'normal';
      }
      continue;
    }

    if (char === '-' && next === '-') {
      state = 'line-comment';
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      i += 1;
      continue;
    }
    if (char === "'") {
      state = 'single';
      continue;
    }
    if (char === '"') {
      state = 'double';
      continue;
    }
    if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
      if (match !== null) {
        dollarTag = match[0];
        state = 'dollar';
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) push(i);
  }
  if (statementStart < text.length) push(text.length);
  return statements;
}

function sqlHeading(text: string, start: number, end: number): string {
  const snippet = text.slice(start, end);
  for (const line of snippet.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('--')) continue;
    return trimmed.slice(0, 80);
  }
  return '';
}

function chunkSql(text: string, index: LineIndex): RawRange[] {
  const statements = sqlStatements(text);
  if (statements.length === 0) {
    return [{ start: 0, end: text.length, heading: '', headingPath: '' }];
  }
  const blocks = statements.map((statement) => ({
    start: statement.start,
    end: statement.end,
    heading: sqlHeading(text, statement.start, statement.end),
  }));

  const result: RawRange[] = [];
  let current: { start: number; end: number; heading: string } | null = null;
  const flush = (): void => {
    if (current !== null) {
      result.push({
        start: current.start,
        end: current.end,
        heading: current.heading,
        headingPath: current.heading,
      });
      current = null;
    }
  };
  for (const block of blocks) {
    const trimmed = trimNewlines(text, block.start, block.end);
    if (trimmed.start >= trimmed.end) continue;
    if (trimmed.end - trimmed.start > LIMITS.maxChunkChars) {
      flush();
      for (const part of splitRangeByLines(
        text,
        index,
        trimmed.start,
        trimmed.end
      )) {
        result.push({
          ...part,
          heading: block.heading,
          headingPath: block.heading,
        });
      }
      continue;
    }
    if (
      current !== null &&
      trimmed.end - current.start > LIMITS.maxChunkChars
    ) {
      flush();
    }
    current =
      current === null
        ? { start: trimmed.start, end: trimmed.end, heading: block.heading }
        : { start: current.start, end: trimmed.end, heading: current.heading };
  }
  flush();
  return result;
}

function paragraphBlocks(text: string): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  const regex = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  blocks.push({ start, end: text.length });
  return blocks;
}

function chunkText(text: string, index: LineIndex): RawRange[] {
  return packBlocks(text, index, paragraphBlocks(text), '', '');
}

function makeChunk(
  text: string,
  index: LineIndex,
  range: RawRange,
  kind: ChunkKind
): ChunkDraft | undefined {
  const trimmed = trimNewlines(text, range.start, range.end);
  if (trimmed.start >= trimmed.end) return undefined;
  const chunkText = text.slice(trimmed.start, trimmed.end);
  let last = trimmed.end - 1;
  while (last > trimmed.start && text[last] === '\n') last -= 1;
  return {
    kind,
    heading: range.heading,
    headingPath: range.headingPath,
    startLine: index.lineAt(trimmed.start),
    endLine: index.lineAt(last),
    text: chunkText,
    charCount: chunkText.length,
    tokenEstimate: estimateTokens(chunkText),
  };
}

export function chunkDocument(options: {
  path: string;
  content: string;
  language?: string;
}): ChunkDocumentResult {
  const canonicalText = canonicalizeText(options.content);
  const kind = detectChunkKind(options.path, options.language);
  if (canonicalText.trim() === '') {
    return { canonicalText, kind, chunks: [], truncated: false };
  }
  const index = new LineIndex(canonicalText);
  let ranges: RawRange[];
  if (kind === 'markdown') ranges = chunkMarkdown(canonicalText, index);
  else if (kind === 'sql') ranges = chunkSql(canonicalText, index);
  else if (kind === 'code') ranges = chunkCode(canonicalText, index);
  else ranges = chunkText(canonicalText, index);

  const chunks: ChunkDraft[] = [];
  let truncated = false;
  for (const range of ranges) {
    const chunk = makeChunk(canonicalText, index, range, kind);
    if (chunk === undefined) continue;
    if (chunks.length >= LIMITS.maxChunksPerDocument) {
      truncated = true;
      break;
    }
    chunks.push(chunk);
  }
  return { canonicalText, kind, chunks, truncated };
}
