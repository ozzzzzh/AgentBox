import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeError } from '../src/errors.js';
import { createRuntime } from '../src/runtime/factory.js';
import { DEFAULT_LIMITS } from '../src/types.js';

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

  it('validates the config before constructing a runtime', () => {
    try {
      createRuntime({
        ...base,
        runtime: 'codex',
        workspaceRoot: join(process.cwd(), 'definitely-missing-workspace'),
      });
      throw new Error('expected createRuntime to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as RuntimeError).name).toBe('RuntimeError');
      expect((error as RuntimeError).code).toBe('INVALID_CONFIG');
    }
  });

  it('exposes resolveApproval on the runtime contract', async () => {
    const runtime = createRuntime({ ...base, runtime: 'codex' });
    await expect(runtime.resolveApproval('t1', 'c1', 'allow')).rejects.toMatchObject(
      { code: 'APPROVAL_NOT_PENDING' }
    );
  });
});
