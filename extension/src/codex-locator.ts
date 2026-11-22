import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface LocateCodexOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  if (!existsSync(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/^"(.*)"$/, '$1').trim();
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function codexCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string[] {
  const pathValue = env.PATH ?? env.Path ?? '';
  const pathDirs = pathValue
    .split(delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, '$1').trim())
    .filter((dir) => dir !== '');
  const names =
    platform === 'win32'
      ? ['codex.cmd', 'codex.exe', 'codex.bat', 'codex']
      : ['codex'];

  const pathCandidates = pathDirs.flatMap((dir) =>
    names.map((name) => join(dir, name))
  );

  const common: string[] = [];
  if (platform === 'win32') {
    if (env.APPDATA !== undefined) {
      common.push(...names.map((name) => join(env.APPDATA!, 'npm', name)));
    }
    if (env.LOCALAPPDATA !== undefined) {
      common.push(
        ...names.map((name) =>
          join(env.LOCALAPPDATA!, 'Programs', 'codex', name)
        )
      );
    }
    common.push(...names.map((name) => join(home, '.codex', 'bin', name)));
  } else if (platform === 'darwin') {
    common.push(
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      join(home, '.npm-global', 'bin', 'codex'),
      join(home, '.local', 'bin', 'codex'),
      join(home, '.codex', 'bin', 'codex')
    );
  } else {
    common.push(
      '/usr/local/bin/codex',
      '/usr/bin/codex',
      join(home, '.local', 'bin', 'codex'),
      join(home, '.npm-global', 'bin', 'codex'),
      join(home, '.codex', 'bin', 'codex')
    );
  }

  return unique([...pathCandidates, ...common]);
}

/**
 * Locate the Codex CLI on PATH or in common npm/homebrew locations. The VSIX
 * never ships the binary; this only fills `agentbox.codex.command` with a
 * concrete path when one is available.
 */
export function locateCodex(options: LocateCodexOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  for (const candidate of codexCandidates(platform, env, home)) {
    if (isExecutable(candidate, platform)) return candidate;
  }
  return undefined;
}
