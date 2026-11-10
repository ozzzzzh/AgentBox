import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  SKILL_CONTENT_FILE,
  SKILL_MANIFEST_FILE,
  createSkillPackage,
  isAllowedSkillFile,
  parseSkillManifest,
  parseSkillPackage,
  serializeSkillPackage,
  type SkillPackage,
} from './model';

export const LOCAL_SKILLS_SETTING_DEFAULT = '';
export const REMOTE_INDEX_FILE = 'index.json';

export interface LocalSkill {
  dir: string;
  skill: SkillPackage;
}

export interface RemoteSkill {
  skill: SkillPackage;
  required: boolean;
  groups?: string[];
  cachedAt: string;
}

export interface RemoteCacheIndex {
  serverUrl: string;
  updatedAt: string;
  skills: Array<{
    id: string;
    version: string;
    required: boolean;
    hash: string;
    groups?: string[];
  }>;
}

export interface SkillReadResult<T> {
  items: T[];
  errors: Array<{ path: string; message: string }>;
}

function safeId(id: string): string {
  return id.replace(/[^a-z0-9._-]/gi, '_');
}

export function defaultLocalSkillsDir(): string {
  return join(homedir(), '.agentbox', 'skills', 'local');
}

export function resolveLocalSkillsDir(configured: string): string {
  const value = configured.trim();
  return value === '' ? defaultLocalSkillsDir() : resolve(value);
}

export function assertInside(base: string, target: string): void {
  const rel = relative(base, target);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return;
  }
  throw new Error(`path escapes ${base}: ${target}`);
}

function readSkillFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(dir, absolute).split(sep).join('/');
      if (!isAllowedSkillFile(rel)) continue;
      files[rel] = readFileSync(absolute, 'utf8');
    }
  };
  walk(dir);
  return files;
}

function sanitizeSkillId(value: string): string {
  const id = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64);
  if (id.length >= 3) return id;
  return `local-${id || 'skill'}`.slice(0, 64);
}

function splitFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { meta: {}, body: normalized };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { meta: {}, body: normalized };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, '');
  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    meta[match[1]!.toLowerCase()] = match[2]!
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return { meta, body };
}

function manifestFromMarkdown(
  dirName: string,
  content: string
): { manifest: unknown; body: string } {
  const { meta, body } = splitFrontmatter(content);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const firstText = body
    .split('\n')
    .map((line) => line.trim())
    .find(
      (line) =>
        line !== '' && !line.startsWith('#') && !line.startsWith('```')
    );
  const id = sanitizeSkillId(meta.id ?? dirName);
  const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(
    meta.version ?? ''
  )
    ? meta.version
    : '0.1.0';
  const activation =
    meta.activation === 'on-demand' || meta.activation === 'manual'
      ? meta.activation
      : 'always';
  const priorityValue = Number(meta.priority ?? '50');
  const priority =
    Number.isInteger(priorityValue) &&
    priorityValue >= 0 &&
    priorityValue <= 1_000
      ? priorityValue
      : 50;
  const name = meta.name ?? heading ?? id;
  const description =
    meta.description ??
    firstText?.slice(0, 200) ??
    `${name} (local skill)`;
  return {
    body,
    manifest: {
      schemaVersion: 1,
      id,
      name,
      version,
      description,
      owner: meta.owner ?? process.env.USERNAME ?? process.env.USER ?? 'local',
      activation,
      priority,
      budget: { maxChars: 8_000 },
      required: false,
    },
  };
}

function readLocalSkillPackage(dir: string): SkillPackage {
  const manifestPath = join(dir, SKILL_MANIFEST_FILE);
  const hasManifest = existsSync(manifestPath);
  const files = readSkillFiles(dir);
  if (hasManifest) {
    const manifest = parseSkillManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
    );
    delete files[SKILL_MANIFEST_FILE];
    return createSkillPackage(manifest, files);
  }

  const content = files[SKILL_CONTENT_FILE];
  if (content === undefined || content.trim() === '') {
    throw new Error(`${SKILL_CONTENT_FILE} is missing or empty`);
  }
  const derived = manifestFromMarkdown(dir.split(/[\\/]/).pop() ?? 'skill', content);
  files[SKILL_CONTENT_FILE] = derived.body;
  return createSkillPackage(derived.manifest, files);
}

export function readLocalSkills(dir: string): SkillReadResult<LocalSkill> {
  if (!existsSync(dir)) return { items: [], errors: [] };
  const items: LocalSkill[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillDir = join(dir, entry.name);
    try {
      items.push({
        dir: skillDir,
        skill: readLocalSkillPackage(skillDir),
      });
    } catch (error) {
      errors.push({
        path: skillDir,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  items.sort((a, b) =>
    a.skill.manifest.id.localeCompare(b.skill.manifest.id)
  );
  return { items, errors };
}

export interface ScaffoldOptions {
  id: string;
  name: string;
  owner: string;
  description?: string;
}

export function scaffoldLocalSkill(
  rootDir: string,
  options: ScaffoldOptions
): LocalSkill {
  const dir = join(rootDir, safeId(options.id));
  assertInside(rootDir, dir);
  if (existsSync(dir)) {
    throw new Error(`skill already exists: ${options.id}`);
  }
  const manifest = parseSkillManifest({
    schemaVersion: 1,
    id: options.id,
    name: options.name,
    version: '0.1.0',
    description:
      options.description ?? `${options.name} (edit skill.json and SKILL.md)`,
    owner: options.owner,
    activation: 'always',
    priority: 50,
    budget: { maxChars: 8000 },
    required: false,
  });
  const content = `# ${options.name}

## 何时使用

描述这个 skill 适用的任务或代码区域。

## 步骤

1.

## 反模式

-

## 验证方式

-
`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SKILL_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(join(dir, SKILL_CONTENT_FILE), content, 'utf8');
  return {
    dir,
    skill: createSkillPackage(manifest, { [SKILL_CONTENT_FILE]: content }),
  };
}

export function deleteLocalSkill(rootDir: string, id: string): void {
  const dir = join(rootDir, safeId(id));
  assertInside(rootDir, dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`skill not found: ${id}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

export function remoteServerHash(serverUrl: string): string {
  return createHash('sha256').update(serverUrl).digest('hex').slice(0, 16);
}

export function remoteCacheRoot(
  globalStorage: string,
  serverUrl: string
): string {
  return join(
    globalStorage,
    'agentbox',
    'skills',
    'remote',
    remoteServerHash(serverUrl)
  );
}

export function remoteIndexPath(
  globalStorage: string,
  serverUrl: string
): string {
  return join(remoteCacheRoot(globalStorage, serverUrl), REMOTE_INDEX_FILE);
}

export function readRemoteIndex(
  globalStorage: string,
  serverUrl: string
): RemoteCacheIndex | undefined {
  const path = remoteIndexPath(globalStorage, serverUrl);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RemoteCacheIndex;
    if (typeof value.serverUrl !== 'string' || !Array.isArray(value.skills)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function writeRemoteIndex(
  globalStorage: string,
  index: RemoteCacheIndex
): void {
  const dir = remoteCacheRoot(globalStorage, index.serverUrl);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, REMOTE_INDEX_FILE);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  // renameSync is atomic on the same filesystem.
  renameSync(temp, path);
}

export function remotePackagePath(
  globalStorage: string,
  serverUrl: string,
  id: string,
  version: string
): string {
  return join(
    remoteCacheRoot(globalStorage, serverUrl),
    safeId(id),
    safeId(version),
    'package.json'
  );
}

export function writeRemoteSkill(
  globalStorage: string,
  serverUrl: string,
  skill: SkillPackage
): void {
  const path = remotePackagePath(
    globalStorage,
    serverUrl,
    skill.manifest.id,
    skill.manifest.version
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(serializeSkillPackage(skill), null, 2)}\n`,
    'utf8'
  );
}

export function readRemoteSkills(
  globalStorage: string,
  serverUrl: string
): SkillReadResult<RemoteSkill> {
  const index = readRemoteIndex(globalStorage, serverUrl);
  if (index === undefined) return { items: [], errors: [] };
  const items: RemoteSkill[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  for (const entry of index.skills) {
    const path = remotePackagePath(
      globalStorage,
      serverUrl,
      entry.id,
      entry.version
    );
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const skill = parseSkillPackage(value);
      if (skill.hash !== entry.hash) {
        throw new Error('cached package hash mismatch');
      }
      if (
        skill.manifest.id !== entry.id ||
        skill.manifest.version !== entry.version
      ) {
        throw new Error('cached package id/version mismatch');
      }
      items.push({
        skill,
        required: entry.required,
        ...(entry.groups === undefined ? {} : { groups: entry.groups }),
        cachedAt: index.updatedAt,
      });
    } catch (error) {
      errors.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { items, errors };
}

export function readInstalledSkillAt(dir: string): SkillPackage {
  return readLocalSkillPackage(dir);
}
