import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_INSTRUCTION_CHARS,
  readProjectInstructions,
} from '../src/project-instructions';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentbox-instructions-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readProjectInstructions', () => {
  it('prefers AGENTS.md over AgentBox.md', () => {
    writeFileSync(join(root, 'AGENTS.md'), 'agents rules', 'utf8');
    writeFileSync(join(root, 'AgentBox.md'), 'agentbox rules', 'utf8');

    const result = readProjectInstructions(root);

    expect(result.text).toBe('agents rules');
    expect(result.path).toMatch(/AGENTS\.md$/);
    expect(result.truncated).toBe(false);
  });

  it('falls back to AgentBox.md', () => {
    writeFileSync(join(root, 'AgentBox.md'), 'agentbox rules', 'utf8');

    const result = readProjectInstructions(root);

    expect(result.text).toBe('agentbox rules');
    expect(result.path).toMatch(/AgentBox\.md$/);
  });

  it('strips a UTF-8 BOM and caps oversized files', () => {
    const long = `﻿${'x'.repeat(
      MAX_PROJECT_INSTRUCTION_CHARS + 100
    )}`;
    writeFileSync(join(root, 'AGENTS.md'), long, 'utf8');

    const result = readProjectInstructions(root);

    expect(result.text?.startsWith('x')).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('truncated');
    expect(result.text?.length).toBeLessThan(long.length);
  });

  it('returns no text when no instruction file exists', () => {
    const result = readProjectInstructions(root);

    expect(result.text).toBeUndefined();
    expect(result.path).toBeUndefined();
    expect(result.truncated).toBe(false);
  });
});
