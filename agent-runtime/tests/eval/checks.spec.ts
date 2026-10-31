import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/eval/checks.js';

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentbox-eval-checks-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'ok.py'), 'def add(a, b):\n    return a + b\n');
  writeFileSync(join(workspace, 'src', 'keep.txt'), 'keep me');
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const base = () => ({ workspaceRoot: workspace, approvals: 0 });

describe('eval checks', () => {
  it('checks text case-insensitively', () => {
    expect(
      runCheck(
        { type: 'text-contains-all', values: ['ASSET', 'knowledge'] },
        { ...base(), text: 'asset and Knowledge' }
      ).ok
    ).toBe(true);
    const missing = runCheck(
      { type: 'text-contains-all', values: ['asset', 'security'] },
      { ...base(), text: 'asset only' }
    );
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('security');
  });

  it('checks files, existence and python compilation', () => {
    expect(
      runCheck(
        { type: 'file-contains', path: 'src/ok.py', value: 'return a + b' },
        { ...base(), text: '' }
      ).ok
    ).toBe(true);
    expect(
      runCheck(
        { type: 'file-not-contains', path: 'src/keep.txt', value: 'delete' },
        { ...base(), text: '' }
      ).ok
    ).toBe(true);
    expect(
      runCheck(
        { type: 'file-exists', path: 'src/keep.txt' },
        { ...base(), text: '' }
      ).ok
    ).toBe(true);
    expect(
      runCheck(
        { type: 'python-compile', path: 'src/ok.py' },
        { ...base(), text: '' }
      ).ok
    ).toBe(true);
  });

  it('supports all and approval checks', () => {
    const all = runCheck(
      {
        type: 'all',
        checks: [
          { type: 'file-exists', path: 'src/keep.txt' },
          { type: 'text-contains-all', values: ['done'] },
        ],
      },
      { ...base(), text: 'done' }
    );
    expect(all.ok).toBe(true);

    const approval = runCheck(
      { type: 'approval-and-file-exists', path: 'src/keep.txt' },
      { ...base(), text: '', approvals: 1 }
    );
    expect(approval.ok).toBe(true);
    expect(
      runCheck(
        { type: 'approval-and-file-exists', path: 'src/keep.txt' },
        { ...base(), text: '', approvals: 0 }
      ).ok
    ).toBe(false);
  });

  it('rejects paths outside the workspace', () => {
    const result = runCheck(
      { type: 'file-exists', path: '../outside.txt' },
      { ...base(), text: '' }
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/escapes workspace/);
  });
});
