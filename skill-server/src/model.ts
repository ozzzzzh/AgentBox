import { createHash } from 'node:crypto';

export const SKILL_SCHEMA_VERSION = 1;
export const SKILL_MANIFEST_FILE = 'skill.json';
export const SKILL_CONTENT_FILE = 'SKILL.md';
export const MAX_SKILL_FILES = 50;
export const MAX_SKILL_PACKAGE_CHARS = 1_000_000;
export const MAX_SKILL_FILE_CHARS = 200_000;

const ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const ALLOWED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.sql',
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.toml',
  '.ini',
  '.conf',
  '.sh',
  '.bash',
  '.ps1',
  '.bat',
  '.cmd',
  '.java',
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.rb',
  '.kt',
  '.kts',
  '.swift',
  '.vue',
  '.svelte',
  '.graphql',
  '.gql',
  '.proto',
]);

export type SkillActivation = 'always' | 'on-demand' | 'manual';

export interface SkillManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  owner: string;
  activation: SkillActivation;
  appliesTo?: { languages?: string[]; paths?: string[] };
  triggers?: { keywords?: string[]; paths?: string[] };
  priority: number;
  budget: { maxChars: number };
  required: boolean;
}

export interface SkillPackage {
  manifest: SkillManifest;
  files: Record<string, string>;
  hash: string;
}

export class SkillValidationError extends Error {
  constructor(message: string, readonly path = '') {
    super(path === '' ? message : `${path}: ${message}`);
    this.name = 'SkillValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  max = 10_000
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new SkillValidationError(`"${key}" must be a string`, key);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new SkillValidationError(`"${key}" must not be empty`, key);
  }
  if (trimmed.length > max) {
    throw new SkillValidationError(`"${key}" is too long`, key);
  }
  return trimmed;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SkillValidationError(`"${key}" must be an array`, path);
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new SkillValidationError(
        `"${key}" must contain non-empty strings`,
        path
      );
    }
    items.push(item.trim());
  }
  return items.length > 0 ? items : undefined;
}

export function parseSkillManifest(value: unknown): SkillManifest {
  if (!isRecord(value)) {
    throw new SkillValidationError('manifest must be an object');
  }
  if (value.schemaVersion !== SKILL_SCHEMA_VERSION) {
    throw new SkillValidationError(
      `unsupported schemaVersion: ${String(value.schemaVersion)}`,
      'schemaVersion'
    );
  }
  const id = stringField(value, 'id', 64);
  if (!ID_RE.test(id)) {
    throw new SkillValidationError('invalid skill id', 'id');
  }
  const version = stringField(value, 'version', 80);
  if (!VERSION_RE.test(version)) {
    throw new SkillValidationError('version must be semver', 'version');
  }
  const activationValue = value.activation ?? 'always';
  if (
    activationValue !== 'always' &&
    activationValue !== 'on-demand' &&
    activationValue !== 'manual'
  ) {
    throw new SkillValidationError('invalid activation', 'activation');
  }
  const priorityValue = value.priority ?? 50;
  if (
    typeof priorityValue !== 'number' ||
    !Number.isInteger(priorityValue) ||
    priorityValue < 0 ||
    priorityValue > 1_000
  ) {
    throw new SkillValidationError('invalid priority', 'priority');
  }
  const budgetValue = value.budget;
  let maxChars = 8_000;
  if (budgetValue !== undefined) {
    if (!isRecord(budgetValue)) {
      throw new SkillValidationError('"budget" must be an object', 'budget');
    }
    const candidate = budgetValue.maxChars;
    if (
      typeof candidate !== 'number' ||
      !Number.isInteger(candidate) ||
      candidate < 200 ||
      candidate > 100_000
    ) {
      throw new SkillValidationError('invalid budget.maxChars', 'budget.maxChars');
    }
    maxChars = candidate;
  }

  let appliesTo: SkillManifest['appliesTo'];
  if (value.appliesTo !== undefined) {
    if (!isRecord(value.appliesTo)) {
      throw new SkillValidationError('"appliesTo" must be an object', 'appliesTo');
    }
    const languages = optionalStringArray(
      value.appliesTo,
      'languages',
      'appliesTo'
    );
    const paths = optionalStringArray(value.appliesTo, 'paths', 'appliesTo');
    if (languages !== undefined || paths !== undefined) {
      appliesTo = {
        ...(languages !== undefined ? { languages } : {}),
        ...(paths !== undefined ? { paths } : {}),
      };
    }
  }

  let triggers: SkillManifest['triggers'];
  if (value.triggers !== undefined) {
    if (!isRecord(value.triggers)) {
      throw new SkillValidationError('"triggers" must be an object', 'triggers');
    }
    const keywords = optionalStringArray(value.triggers, 'keywords', 'triggers');
    const paths = optionalStringArray(value.triggers, 'paths', 'triggers');
    if (keywords !== undefined || paths !== undefined) {
      triggers = {
        ...(keywords !== undefined ? { keywords } : {}),
        ...(paths !== undefined ? { paths } : {}),
      };
    }
  }

  return {
    schemaVersion: SKILL_SCHEMA_VERSION,
    id,
    name: stringField(value, 'name', 200),
    version,
    description: stringField(value, 'description', 4_000),
    owner: stringField(value, 'owner', 200),
    activation: activationValue,
    ...(appliesTo !== undefined ? { appliesTo } : {}),
    ...(triggers !== undefined ? { triggers } : {}),
    priority: priorityValue,
    budget: { maxChars },
    required: value.required === true,
  };
}

function normalizePath(path: string): string {
  if (path === '' || path.startsWith('/') || path.includes('\\')) {
    throw new SkillValidationError('file path must be POSIX relative', path);
  }
  const segments = path.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    )
  ) {
    throw new SkillValidationError('file path must not contain . or ..', path);
  }
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new SkillValidationError(
      `unsupported file extension: ${extension}`,
      path
    );
  }
  return path;
}

export function normalizeSkillFiles(
  files: Record<string, unknown>
): Record<string, string> {
  const entries = Object.entries(files);
  if (entries.length === 0) {
    throw new SkillValidationError('package must contain files');
  }
  if (entries.length > MAX_SKILL_FILES) {
    throw new SkillValidationError(`too many files (max ${MAX_SKILL_FILES})`);
  }
  const normalized: Record<string, string> = {};
  let total = 0;
  for (const [rawPath, rawContent] of entries) {
    const path = normalizePath(rawPath);
    if (typeof rawContent !== 'string') {
      throw new SkillValidationError('file content must be a string', path);
    }
    if (rawContent.length > MAX_SKILL_FILE_CHARS) {
      throw new SkillValidationError('file is too large', path);
    }
    total += rawContent.length;
    if (total > MAX_SKILL_PACKAGE_CHARS) {
      throw new SkillValidationError('package is too large');
    }
    normalized[path] = rawContent;
  }
  if (normalized[SKILL_CONTENT_FILE] === undefined) {
    throw new SkillValidationError(
      `${SKILL_CONTENT_FILE} is required`,
      SKILL_CONTENT_FILE
    );
  }
  return normalized;
}

function canonicalFiles(files: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(files)
      .sort()
      .map((path) => [path, files[path]])
  );
}

export function computeSkillHash(
  manifest: SkillManifest,
  files: Record<string, string>
): string {
  const payload = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    owner: manifest.owner,
    activation: manifest.activation,
    appliesTo: manifest.appliesTo ?? null,
    triggers: manifest.triggers ?? null,
    priority: manifest.priority,
    budget: manifest.budget,
    required: manifest.required,
    files: canonicalFiles(files),
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function parseSkillPackage(value: unknown): SkillPackage {
  if (!isRecord(value)) {
    throw new SkillValidationError('skill package must be an object');
  }
  const manifest = parseSkillManifest(value.manifest);
  const files = normalizeSkillFiles(isRecord(value.files) ? value.files : {});
  const hash = computeSkillHash(manifest, files);
  if (typeof value.hash !== 'string' || value.hash !== hash) {
    throw new SkillValidationError('package hash mismatch', 'hash');
  }
  return { manifest, files, hash };
}
