import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeError, type RuntimeErrorCode } from '../../src/errors.js';
import {
  assertInsideWorkspace,
  assertRealPathInsideWorkspace,
  toWorkspaceRelative,
} from '../../src/security/paths.js';

let base: string;
let workspace: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'agentbox-paths-'));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  mkdirSync(join(base, 'workspace-sibling'));
  writeFileSync(join(workspace, 'inside.txt'), 'inside');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function expectRuntimeError(
  fn: () => unknown,
  code: RuntimeErrorCode
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as RuntimeError).name).toBe('RuntimeError');
    expect((error as RuntimeError).code).toBe(code);
    return;
  }
  throw new Error(`expected RuntimeError(${code}) but nothing was thrown`);
}

describe('assertInsideWorkspace', () => {
  it('accepts absolute and relative paths inside the workspace', () => {
    expect(assertInsideWorkspace(workspace, join(workspace, 'inside.txt'))).toBe(
      join(workspace, 'inside.txt')
    );
    expect(assertInsideWorkspace(workspace, 'inside.txt')).toBe(
      join(workspace, 'inside.txt')
    );
    expect(assertInsideWorkspace(workspace, join('sub', 'new.txt'))).toBe(
      join(workspace, 'sub', 'new.txt')
    );
  });

  it('accepts the workspace root itself', () => {
    expect(assertInsideWorkspace(workspace, workspace)).toBe(workspace);
  });

  it('rejects ../ escapes', () => {
    expectRuntimeError(
      () => assertInsideWorkspace(workspace, join(workspace, '..', 'outside', 'secret.txt')),
      'POLICY_DENIED'
    );
    expectRuntimeError(
      () => assertInsideWorkspace(workspace, '../outside/secret.txt'),
      'POLICY_DENIED'
    );
  });

  it('rejects absolute paths outside the workspace', () => {
    expectRuntimeError(
      () => assertInsideWorkspace(workspace, join(outside, 'secret.txt')),
      'POLICY_DENIED'
    );
  });

  it('rejects a sibling directory with the same prefix', () => {
    expectRuntimeError(
      () =>
        assertInsideWorkspace(
          workspace,
          join(base, 'workspace-sibling', 'file.txt')
        ),
      'POLICY_DENIED'
    );
  });

  it('rejects empty paths and null bytes', () => {
    expectRuntimeError(() => assertInsideWorkspace('', 'a.txt'), 'INVALID_ARGUMENT');
    expectRuntimeError(() => assertInsideWorkspace(workspace, ''), 'INVALID_ARGUMENT');
    expectRuntimeError(
      () => assertInsideWorkspace(workspace, 'bad\0name.txt'),
      'INVALID_ARGUMENT'
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'treats Windows path casing as equivalent',
    () => {
      const upperCase = join(workspace, 'inside.txt').toUpperCase();
      expect(() => assertInsideWorkspace(workspace, upperCase)).not.toThrow();
    }
  );

  it.skipIf(process.platform !== 'win32')(
    'rejects drive-relative paths',
    () => {
      const driveRelative = `${workspace.slice(0, 2)}relative.txt`;
      expectRuntimeError(
        () => assertInsideWorkspace(workspace, driveRelative),
        'INVALID_ARGUMENT'
      );
    }
  );
});

describe('toWorkspaceRelative', () => {
  it('returns POSIX separators without a leading slash', () => {
    expect(
      toWorkspaceRelative(workspace, join(workspace, 'sub', 'file.txt'))
    ).toBe('sub/file.txt');
    expect(toWorkspaceRelative(workspace, 'inside.txt')).toBe('inside.txt');
  });

  it('maps the workspace root to .', () => {
    expect(toWorkspaceRelative(workspace, workspace)).toBe('.');
  });

  it('rejects paths outside the workspace', () => {
    expectRuntimeError(
      () => toWorkspaceRelative(workspace, join(outside, 'secret.txt')),
      'POLICY_DENIED'
    );
  });
});

describe('assertRealPathInsideWorkspace', () => {
  it('accepts existing files inside the workspace', () => {
    expect(
      assertRealPathInsideWorkspace(workspace, join(workspace, 'inside.txt'))
    ).toBe(join(workspace, 'inside.txt'));
  });

  it('accepts missing trailing segments whose ancestor is inside', () => {
    expect(
      assertRealPathInsideWorkspace(workspace, join(workspace, 'new', 'file.txt'))
    ).toBe(join(workspace, 'new', 'file.txt'));
  });

  it('rejects an inaccessible workspace root', () => {
    expectRuntimeError(
      () =>
        assertRealPathInsideWorkspace(
          join(base, 'missing-workspace'),
          join(base, 'missing-workspace', 'file.txt')
        ),
      'INVALID_ARGUMENT'
    );
  });

  it('rejects symlink escapes', (ctx) => {
    const link = join(workspace, 'link-out');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      ctx.skip();
      return;
    }

    // Lexical check cannot see the escape; the realpath check must.
    expect(() =>
      assertInsideWorkspace(workspace, join(link, 'secret.txt'))
    ).not.toThrow();
    expectRuntimeError(
      () =>
        assertRealPathInsideWorkspace(workspace, join(link, 'secret.txt')),
      'POLICY_DENIED'
    );
  });
});
