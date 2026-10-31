import { realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { RuntimeError } from '../errors.js';

function invalidArgument(message: string): RuntimeError {
  return new RuntimeError('INVALID_ARGUMENT', message);
}

function policyDenied(message: string): RuntimeError {
  return new RuntimeError('POLICY_DENIED', message);
}

function assertPathArgument(name: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidArgument(`${name} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw invalidArgument(`${name} must not contain null bytes`);
  }
  // Drive-relative paths (e.g. "C:foo") resolve against the drive's CWD,
  // which may be outside the workspace. Reject them outright.
  if (process.platform === 'win32' && /^[a-zA-Z]:(?![\\/])/.test(value)) {
    throw invalidArgument(`${name} must not be drive-relative: ${value}`);
  }
}

/**
 * Lexical check only. Returns the resolved absolute candidate path.
 * Use `assertRealPathInsideWorkspace` when symlinks are a concern.
 */
function toRelativeOrDeny(
  rootAbs: string,
  candidateAbs: string
): string {
  const rel = relative(rootAbs, candidateAbs);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw policyDenied(`path escapes workspace: ${candidateAbs}`);
  }
  return rel;
}

function realpathWithMissingSegments(input: string): string {
  let current = resolve(input);
  const missing: string[] = [];

  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0
        ? real
        : resolve(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(input);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `candidate` (absolute or relative to workspaceRoot) and assert it
 * stays inside the workspace. Symlinks are not resolved.
 *
 * @throws RuntimeError('POLICY_DENIED') when the path escapes the workspace.
 * @throws RuntimeError('INVALID_ARGUMENT') for empty/null-byte paths.
 */
export function assertInsideWorkspace(
  workspaceRoot: string,
  candidate: string
): string {
  assertPathArgument('workspaceRoot', workspaceRoot);
  assertPathArgument('candidate', candidate);

  const rootAbs = resolve(workspaceRoot);
  const candidateAbs = resolve(rootAbs, candidate);
  toRelativeOrDeny(rootAbs, candidateAbs);
  return candidateAbs;
}

/**
 * Convert a path to a workspace-relative POSIX path as required by
 * `file.changed.path` (no leading slash, no `..`). The workspace root
 * itself maps to '.'.
 */
export function toWorkspaceRelative(
  workspaceRoot: string,
  candidate: string
): string {
  const rootAbs = resolve(workspaceRoot);
  const candidateAbs = assertInsideWorkspace(workspaceRoot, candidate);
  return toRelativeOrDeny(rootAbs, candidateAbs).split(sep).join('/');
}

/**
 * Like `assertInsideWorkspace`, but also resolves symlinks (including the
 * workspace root) so a link inside the workspace cannot escape it.
 *
 * Missing trailing segments are allowed: the deepest existing ancestor is
 * resolved and the remainder is appended. Returns the real path.
 *
 * @throws RuntimeError('POLICY_DENIED') when the real path escapes.
 * @throws RuntimeError('INVALID_ARGUMENT') when the workspace is inaccessible.
 */
export function assertRealPathInsideWorkspace(
  workspaceRoot: string,
  candidate: string
): string {
  assertPathArgument('workspaceRoot', workspaceRoot);
  assertPathArgument('candidate', candidate);

  const rootAbs = resolve(workspaceRoot);
  const candidateAbs = resolve(rootAbs, candidate);

  // Fail fast on obvious lexical escapes before touching the filesystem.
  toRelativeOrDeny(rootAbs, candidateAbs);

  let realRoot: string;
  try {
    realRoot = realpathSync.native(rootAbs);
  } catch (error) {
    throw new RuntimeError(
      'INVALID_ARGUMENT',
      `workspaceRoot is not accessible: ${workspaceRoot}`,
      error
    );
  }

  const realCandidate = realpathWithMissingSegments(candidateAbs);
  toRelativeOrDeny(realRoot, realCandidate);
  return realCandidate;
}
