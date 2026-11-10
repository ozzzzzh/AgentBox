import { createHash } from 'node:crypto';

export const SKILL_SCHEMA_VERSION = 1;
export const SKILL_MANIFEST_FILE = 'skill.json';
export const SKILL_CONTENT_FILE = 'SKILL.md';
export const MAX_SKILL_FILES = 50;
export const MAX_SKILL_PACKAGE_CHARS = 1_000_000;
export const MAX_SKILL_FILE_CHARS = 200_000;
export const DEFAULT_SKILL_BUDGET_CHARS = 8_000;

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
export type SkillSource = 'local' | 'remote';

export interface SkillAppliesTo {
  languages?: string[];
  paths?: string[];
}

export interface SkillTriggers {
  keywords?: string[];
  paths?: string[];
}

export interface SkillManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  owner: string;
  activation: SkillActivation;
  appliesTo?: SkillAppliesTo;
  triggers?: SkillTriggers;
  priority: number;
  budget: { maxChars: number };
  /** Server-controlled for remote skills. Local values are ignored. */
  required: boolean;
}

export interface SkillPackage {
  manifest: SkillManifest;
  files: Record<string, string>;
  hash: string;
}

export interface SkillUsage {
  id: string;
  version: string;
  hash: string;
  source: SkillSource;
  required: boolean;
}

export class SkillValidationError extends Error {
  constructor(
    message: string,
    readonly path = ''
  ) {
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
  options: { min?: number; max?: number } = {}
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new SkillValidationError(`"${key}" must be a string`, key);
  }
  const trimmed = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 10_000;
  if (trimmed.length < min) {
    throw new SkillValidationError(`"${key}" is too short`, key);
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
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== SKILL_SCHEMA_VERSION) {
    throw new SkillValidationError(
      `unsupported schemaVersion: ${String(schemaVersion)}`,
      'schemaVersion'
    );
  }

  const id = stringField(value, 'id', { max: 64 });
  if (!ID_RE.test(id)) {
    throw new SkillValidationError(
      'id must match ^[a-z0-9][a-z0-9._-]{2,63}$',
      'id'
    );
  }
  const version = stringField(value, 'version', { max: 80 });
  if (!VERSION_RE.test(version)) {
    throw new SkillValidationError('version must be semver', 'version');
  }

  const activationValue = value.activation ?? 'always';
  const activation =
    activationValue === 'always' ||
    activationValue === 'on-demand' ||
    activationValue === 'manual'
      ? activationValue
      : undefined;
  if (activation === undefined) {
    throw new SkillValidationError(
      'activation must be always, on-demand or manual',
      'activation'
    );
  }

  const appliesToValue = value.appliesTo;
  let appliesTo: SkillAppliesTo | undefined;
  if (appliesToValue !== undefined) {
    if (!isRecord(appliesToValue)) {
      throw new SkillValidationError(
        '"appliesTo" must be an object',
        'appliesTo'
      );
    }
    const languages = optionalStringArray(
      appliesToValue,
      'languages',
      'appliesTo'
    );
    const paths = optionalStringArray(appliesToValue, 'paths', 'appliesTo');
    if (languages !== undefined || paths !== undefined) {
      appliesTo = {
        ...(languages !== undefined ? { languages } : {}),
        ...(paths !== undefined ? { paths } : {}),
      };
    }
  }

  const triggersValue = value.triggers;
  let triggers: SkillTriggers | undefined;
  if (triggersValue !== undefined) {
    if (!isRecord(triggersValue)) {
      throw new SkillValidationError(
        '"triggers" must be an object',
        'triggers'
      );
    }
    const keywords = optionalStringArray(triggersValue, 'keywords', 'triggers');
    const paths = optionalStringArray(triggersValue, 'paths', 'triggers');
    if (keywords !== undefined || paths !== undefined) {
      triggers = {
        ...(keywords !== undefined ? { keywords } : {}),
        ...(paths !== undefined ? { paths } : {}),
      };
    }
  }

  const priorityValue = value.priority ?? 50;
  if (
    typeof priorityValue !== 'number' ||
    !Number.isInteger(priorityValue) ||
    priorityValue < 0 ||
    priorityValue > 1_000
  ) {
    throw new SkillValidationError(
      'priority must be an integer between 0 and 1000',
      'priority'
    );
  }

  const budgetValue = value.budget;
  let maxChars = DEFAULT_SKILL_BUDGET_CHARS;
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
      throw new SkillValidationError(
        'budget.maxChars must be an integer between 200 and 100000',
        'budget.maxChars'
      );
    }
    maxChars = candidate;
  }

  return {
    schemaVersion: SKILL_SCHEMA_VERSION,
    id,
    name: stringField(value, 'name', { max: 200 }),
    version,
    description: stringField(value, 'description', { max: 4_000 }),
    owner: stringField(value, 'owner', { max: 200 }),
    activation,
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

export function isAllowedSkillFile(path: string): boolean {
  try {
    normalizePath(path);
    return true;
  } catch {
    return false;
  }
}

export function normalizeSkillFiles(
  files: Record<string, unknown>
): Record<string, string> {
  const entries = Object.entries(files);
  if (entries.length === 0) {
    throw new SkillValidationError('package must contain files');
  }
  if (entries.length > MAX_SKILL_FILES) {
    throw new SkillValidationError(
      `too many files (max ${MAX_SKILL_FILES})`
    );
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
  if (normalized[SKILL_CONTENT_FILE]!.trim() === '') {
    throw new SkillValidationError(
      `${SKILL_CONTENT_FILE} must not be empty`,
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

export function createSkillPackage(
  manifestValue: unknown,
  filesValue: Record<string, unknown>
): SkillPackage {
  const manifest = parseSkillManifest(manifestValue);
  const files = normalizeSkillFiles(filesValue);
  return {
    manifest,
    files,
    hash: computeSkillHash(manifest, files),
  };
}

export function parseSkillPackage(value: unknown): SkillPackage {
  if (!isRecord(value)) {
    throw new SkillValidationError('skill package must be an object');
  }
  const manifest = parseSkillManifest(value.manifest);
  const files = normalizeSkillFiles(
    isRecord(value.files) ? value.files : {}
  );
  const hash = computeSkillHash(manifest, files);
  if (typeof value.hash === 'string' && value.hash !== hash) {
    throw new SkillValidationError('package hash mismatch', 'hash');
  }
  return { manifest, files, hash };
}

export function serializeSkillPackage(skill: SkillPackage): unknown {
  return {
    manifest: skill.manifest,
    files: skill.files,
    hash: skill.hash,
  };
}

export function skillContent(skill: SkillPackage): string {
  return skill.files[SKILL_CONTENT_FILE] ?? '';
}

export function formatSkillLabel(skill: SkillPackage): string {
  return `${skill.manifest.id}@${skill.manifest.version}`;
}

export function usageOf(
  skill: SkillPackage,
  source: SkillSource
): SkillUsage {
  return {
    id: skill.manifest.id,
    version: skill.manifest.version,
    hash: skill.hash,
    source,
    required: source === 'remote' && skill.manifest.required,
  };
}
