/**
 * Minimal child-process environment builder.
 *
 * By default only a small allowlist is inherited from the parent process, so
 * secrets such as MODEL_API_KEY never reach a child unless explicitly passed
 * via `extra` (or explicitly allowlisted by the caller).
 */

const WINDOWS_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'SYSTEMDRIVE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'LANG',
  'LC_ALL',
  'TZ',
] as const;

const POSIX_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TERM',
  'TZ',
] as const;

function findParentValue(
  parent: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const direct = parent[name];
  if (direct !== undefined) return direct;

  if (process.platform === 'win32') {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(parent)) {
      if (key.toLowerCase() === lower && value !== undefined) return value;
    }
  }
  return undefined;
}

function setEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string
): void {
  if (process.platform === 'win32') {
    const existing = Object.keys(env).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase()
    );
    if (existing !== undefined) {
      env[existing] = value;
      return;
    }
  }
  env[key] = value;
}

/**
 * Build a minimal environment for a child process.
 *
 * @param parent    usually `process.env`
 * @param extra     variables to add/override (e.g. MODEL_API_KEY for the model
 *                  gateway). Never log these.
 * @param allowlist additional parent variables to inherit, beyond the
 *                  platform default allowlist.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
  allowlist: readonly string[] = []
): NodeJS.ProcessEnv {
  const platformAllowlist =
    process.platform === 'win32'
      ? WINDOWS_ENV_ALLOWLIST
      : POSIX_ENV_ALLOWLIST;

  const result: NodeJS.ProcessEnv = {};

  for (const name of [...platformAllowlist, ...allowlist]) {
    const value = findParentValue(parent, name);
    if (value !== undefined) {
      setEnv(result, name, value);
    }
  }

  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') {
      setEnv(result, key, value);
    }
  }

  return result;
}
