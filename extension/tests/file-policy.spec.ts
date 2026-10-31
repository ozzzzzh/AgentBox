import { describe, expect, it } from 'vitest';
import { evaluateApprovalPolicy } from '../src/file-policy';
import type { ApprovalPrompt } from '../src/controller';

const root = 'D:\\work';

function prompt(name: string, args: unknown): ApprovalPrompt {
  return { turnId: 't1', callId: 'c1', name, args };
}

describe('evaluateApprovalPolicy', () => {
  it('denies file changes matching a denied path pattern', () => {
    const result = evaluateApprovalPolicy(
      prompt('applyPatch', {
        fileChanges: [{ path: '.chrome-profile/Default/Preferences' }],
      }),
      root
    );

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('.chrome-profile');
  });

  it('denies absolute paths that match a denied pattern', () => {
    const result = evaluateApprovalPolicy(
      prompt('applyPatch', {
        fileChanges: [{ path: 'D:\\work\\.codex-poem.patch' }],
      }),
      root
    );

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('.patch');
  });

  it('denies commands containing junk artifact markers', () => {
    const result = evaluateApprovalPolicy(
      prompt('commandExecution', {
        command: 'Set-Content -Path preview.png -Value test',
      }),
      root
    );

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('preview.png');
  });

  it('asks for confirmation for browser automation commands', () => {
    const result = evaluateApprovalPolicy(
      prompt('commandExecution', {
        command: 'chrome --headless --dump-dom http://localhost',
      }),
      root
    );

    expect(result.decision).toBe('confirm');
    expect(result.reason).toContain('浏览器');
  });

  it('allows ordinary commands', () => {
    const result = evaluateApprovalPolicy(
      prompt('commandExecution', { command: 'npm test' }),
      root
    );

    expect(result.decision).toBe('allow');
  });

  it('supports custom deny patterns', () => {
    const result = evaluateApprovalPolicy(
      prompt('applyPatch', { fileChanges: [{ path: 'docs/generated.md' }] }),
      root,
      ['**/generated.md']
    );

    expect(result.decision).toBe('deny');
  });
});
