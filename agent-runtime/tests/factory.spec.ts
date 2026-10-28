import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/runtime/factory';
import { DEFAULT_LIMITS } from '../src/types';

const base = {
  workspaceRoot: process.cwd(),
  limits: DEFAULT_LIMITS,
};

describe('createRuntime', () => {
  it('creates the Codex runtime', () => {
    expect(createRuntime({ ...base, runtime: 'codex' }).id).toBe('codex');
  });

  it('creates the OpenCode runtime', () => {
    expect(createRuntime({ ...base, runtime: 'opencode' }).id).toBe('opencode');
  });

  it('rejects OpenClaw / unknown runtimes', () => {
    expect(() => createRuntime({ ...base, runtime: 'openclaw' as never })).toThrow(
      /Unsupported runtime/
    );
  });
});
