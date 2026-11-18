import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';

export interface ScannerStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export interface ScannerIo {
  /** Absolute paths matching `include`, excluding `exclude`. */
  findFiles(
    include: string,
    exclude: string,
    maxResults: number
  ): Promise<string[]>;
  stat(path: string): Promise<ScannerStat>;
  readFile(path: string): Promise<Uint8Array>;
}

export interface ScannedDocument {
  path: string;
  content: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  collection: string;
  documents: ScannedDocument[];
  skipped: Array<{ path: string; reason: string }>;
  truncated: boolean;
}

export const DEFAULT_EXCLUDES =
  '**/{.git,.probe,.vscode-test,node_modules,dist,build,out,coverage,next,.next,.venv,venv,__pycache__,target,vendor}/**';

const ALLOWED_EXTENSIONS = new Set([
  'md',
  'mdx',
  'txt',
  'sql',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'java',
  'go',
  'rs',
  'cs',
  'c',
  'h',
  'cpp',
  'hpp',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'scala',
  'sh',
  'ps1',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'html',
  'css',
  'scss',
  'vue',
  'svelte',
]);

const IGNORED_SEGMENTS = new Set([
  '.git',
  '.probe',
  '.vscode-test',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'next',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
]);

const SECRET_FILE =
  /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_rsa.*|credentials.*|secrets.*)$/i;

export function isSecretFileName(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return SECRET_FILE.test(name);
}

function isIgnoredPath(path: string): boolean {
  return path
    .split('/')
    .some((segment) => IGNORED_SEGMENTS.has(segment));
}

function isAllowedExtension(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  if (/\.min\.(?:js|css)$/i.test(name) || /\.map$/i.test(name)) return false;
  if (/\.lock$/i.test(name) || /\.vsix$/i.test(name)) return false;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return ALLOWED_EXTENSIONS.has(ext);
}

export function canonicalizeContent(input: string): string {
  return input
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC');
}

export function contentHash(canonicalContent: string): string {
  return createHash('sha256').update(canonicalContent, 'utf8').digest('hex');
}

export function collectionForRoot(root: string): string {
  const normalized =
    process.platform === 'win32'
      ? root.replace(/\\/g, '/').toLowerCase()
      : root.replace(/\\/g, '/');
  return `ws_${contentHash(normalized).slice(0, 16)}`;
}

export function workspaceRelativePath(
  root: string,
  absolutePath: string
): string | undefined {
  const rel = relative(root, absolutePath);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return undefined;
  }
  return rel.split(sep).join('/');
}

export async function scanWorkspace(options: {
  root: string;
  io: ScannerIo;
  maxFiles?: number;
  maxFileBytes?: number;
}): Promise<ScanResult> {
  const maxFiles = Math.max(1, options.maxFiles ?? 5_000);
  const maxFileBytes = Math.max(1, options.maxFileBytes ?? 1024 * 1024);
  const collection = collectionForRoot(options.root);
  const skipped: Array<{ path: string; reason: string }> = [];
  const discovered = await options.io.findFiles(
    '**/*',
    DEFAULT_EXCLUDES,
    maxFiles + 1
  );
  const truncated = discovered.length > maxFiles;
  const files = discovered.slice(0, maxFiles).sort();
  const documents: ScannedDocument[] = [];

  for (const absolute of files) {
    const path = workspaceRelativePath(options.root, absolute);
    if (path === undefined) {
      skipped.push({ path: absolute, reason: 'outside workspace' });
      continue;
    }
    if (isIgnoredPath(path) || isSecretFileName(path) || !isAllowedExtension(path)) {
      continue;
    }
    let stat: ScannerStat;
    try {
      stat = await options.io.stat(absolute);
    } catch (error) {
      skipped.push({
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!stat.isFile || stat.isSymbolicLink) continue;
    if (stat.size === 0) continue;
    if (stat.size > maxFileBytes) {
      skipped.push({ path, reason: 'file too large' });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await options.io.readFile(absolute);
    } catch (error) {
      skipped.push({
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (bytes.includes(0)) {
      skipped.push({ path, reason: 'binary file' });
      continue;
    }
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      skipped.push({ path, reason: 'invalid UTF-8' });
      continue;
    }
    const content = canonicalizeContent(raw);
    if (content.trim() === '') continue;
    documents.push({
      path,
      content,
      contentHash: contentHash(content),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  return { collection, documents, skipped, truncated };
}
