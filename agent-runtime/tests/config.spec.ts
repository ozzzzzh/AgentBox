import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveLimits,
  resolveTurnLimits,
  validateRuntimeConfig,
  validateTurnInput,
} from '../src/config.js';
import { RuntimeError, type RuntimeErrorCode } from '../src/errors.js';
import {
  DEFAULT_LIMITS,
  type Limits,
  type RuntimeConfig,
  type TurnInput,
} from '../src/types.js';

let workspace: string;
let filePath: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentbox-runtime-config-'));
  filePath = join(workspace, 'not-a-directory.txt');
  writeFileSync(filePath, 'x');
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function expectRuntimeError(
  fn: () => unknown,
  code: RuntimeErrorCode
): RuntimeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const runtimeError = error as RuntimeError;
    expect(runtimeError.name).toBe('RuntimeError');
    expect(runtimeError.code).toBe(code);
    return runtimeError;
  }
  throw new Error(`expected RuntimeError(${code}) but nothing was thrown`);
}

function codexConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { runtime: 'codex', workspaceRoot: workspace, ...overrides };
}

describe('validateRuntimeConfig', () => {
  it('accepts a minimal codex config', () => {
    expect(() => validateRuntimeConfig(codexConfig())).not.toThrow();
  });

  it('accepts an opencode config bound to loopback', () => {
    expect(() =>
      validateRuntimeConfig({
        runtime: 'opencode',
        workspaceRoot: workspace,
        opencode: { hostname: '127.0.0.1', port: 0 },
      })
    ).not.toThrow();
  });

  it('rejects unknown runtimes with INVALID_RUNTIME', () => {
    expectRuntimeError(
      () =>
        validateRuntimeConfig({
          runtime: 'openclaw' as never,
          workspaceRoot: workspace,
        }),
      'INVALID_RUNTIME'
    );
  });

  it('rejects a missing workspaceRoot', () => {
    expectRuntimeError(
      () => validateRuntimeConfig({ runtime: 'codex' } as never),
      'INVALID_CONFIG'
    );
  });

  it('rejects a nonexistent workspaceRoot', () => {
    expectRuntimeError(
      () =>
        validateRuntimeConfig({
          runtime: 'codex',
          workspaceRoot: join(workspace, 'missing'),
        }),
      'INVALID_CONFIG'
    );
  });

  it('rejects a workspaceRoot that is not a directory', () => {
    expectRuntimeError(
      () => validateRuntimeConfig({ runtime: 'codex', workspaceRoot: filePath }),
      'INVALID_CONFIG'
    );
  });

  it('rejects invalid limits', () => {
    expectRuntimeError(
      () => validateRuntimeConfig(codexConfig({ limits: { maxSteps: 0 } })),
      'INVALID_CONFIG'
    );
    expectRuntimeError(
      () =>
        validateRuntimeConfig(
          codexConfig({ limits: { maxSteps: 1.5 } as Partial<Limits> })
        ),
      'INVALID_CONFIG'
    );
  });

  it('rejects unknown limit keys', () => {
    expectRuntimeError(
      () =>
        validateRuntimeConfig(
          codexConfig({ limits: { nope: 1 } as unknown as Partial<Limits> })
        ),
      'INVALID_CONFIG'
    );
  });

  it('rejects non-loopback opencode hostnames', () => {
    for (const hostname of ['0.0.0.0', '192.168.1.10', 'example.com']) {
      expectRuntimeError(
        () =>
          validateRuntimeConfig({
            runtime: 'opencode',
            workspaceRoot: workspace,
            opencode: { hostname },
          }),
        'INVALID_CONFIG'
      );
    }
  });

  it('accepts localhost and IPv6 loopback', () => {
    for (const hostname of ['localhost', '::1']) {
      expect(() =>
        validateRuntimeConfig({
          runtime: 'opencode',
          workspaceRoot: workspace,
          opencode: { hostname },
        })
      ).not.toThrow();
    }
  });

  it('rejects invalid opencode ports', () => {
    for (const port of [-1, 65536, 1.5]) {
      expectRuntimeError(
        () =>
          validateRuntimeConfig({
            runtime: 'opencode',
            workspaceRoot: workspace,
            opencode: { port },
          }),
        'INVALID_CONFIG'
      );
    }
  });

  it('rejects empty command / env values with the wrong type', () => {
    expectRuntimeError(
      () => validateRuntimeConfig(codexConfig({ codex: { command: '  ' } })),
      'INVALID_CONFIG'
    );
    expectRuntimeError(
      () =>
        validateRuntimeConfig(
          codexConfig({
            codex: { env: { MODEL_API_KEY: 1 as unknown as string } },
          })
        ),
      'INVALID_CONFIG'
    );
  });
});

describe('resolveLimits', () => {
  it('returns a fresh copy of the defaults', () => {
    const limits = resolveLimits();
    expect(limits).toEqual(DEFAULT_LIMITS);
    expect(limits).not.toBe(DEFAULT_LIMITS);
  });

  it('applies later sources over earlier ones', () => {
    const limits = resolveLimits(
      { maxSteps: 3, toolTimeoutMs: 1000 },
      { maxSteps: 5 }
    );
    expect(limits.maxSteps).toBe(5);
    expect(limits.toolTimeoutMs).toBe(1000);
    expect(limits.maxToolCallsPerTurn).toBe(
      DEFAULT_LIMITS.maxToolCallsPerTurn
    );
  });

  it('does not mutate DEFAULT_LIMITS', () => {
    resolveLimits({ maxSteps: 99 });
    expect(DEFAULT_LIMITS.maxSteps).toBe(12);
  });

  it('rejects zero, negative and non-integer limits', () => {
    expectRuntimeError(() => resolveLimits({ maxSteps: 0 }), 'INVALID_CONFIG');
    expectRuntimeError(
      () => resolveLimits({ toolTimeoutMs: -1 }),
      'INVALID_CONFIG'
    );
    expectRuntimeError(
      () => resolveLimits({ maxContextTokens: 1.5 }),
      'INVALID_CONFIG'
    );
  });
});

describe('resolveTurnLimits', () => {
  it('lets per-turn limits override config defaults', () => {
    const config = codexConfig({ limits: { maxSteps: 5 } });
    const input: TurnInput = {
      prompt: 'hello',
      workspaceRoot: workspace,
      limits: { maxSteps: 8 },
    };
    const limits = resolveTurnLimits(config, input);
    expect(limits.maxSteps).toBe(8);
    expect(limits.turnTimeoutMs).toBe(DEFAULT_LIMITS.turnTimeoutMs);
  });
});

describe('validateTurnInput', () => {
  it('accepts a valid turn input', () => {
    expect(() =>
      validateTurnInput({
        prompt: 'hello',
        workspaceRoot: workspace,
        context: 'knowledge',
        limits: { maxSteps: 4 },
        metadata: { sessionId: 's1' },
      })
    ).not.toThrow();
  });

  it('rejects empty or whitespace prompts', () => {
    for (const prompt of ['', '   ', '\n\t']) {
      expectRuntimeError(
        () => validateTurnInput({ prompt, workspaceRoot: workspace }),
        'INVALID_CONFIG'
      );
    }
  });

  it('rejects an invalid workspaceRoot', () => {
    expectRuntimeError(
      () =>
        validateTurnInput({
          prompt: 'hello',
          workspaceRoot: join(workspace, 'missing'),
        }),
      'INVALID_CONFIG'
    );
  });

  it('rejects invalid limits and non-string context', () => {
    expectRuntimeError(
      () =>
        validateTurnInput({
          prompt: 'hello',
          workspaceRoot: workspace,
          limits: { maxSteps: 0 },
        }),
      'INVALID_CONFIG'
    );
    expectRuntimeError(
      () =>
        validateTurnInput({
          prompt: 'hello',
          workspaceRoot: workspace,
          context: 42 as unknown as string,
        }),
      'INVALID_CONFIG'
    );
  });

  it('rejects metadata that is not serializable', () => {
    expectRuntimeError(
      () =>
        validateTurnInput({
          prompt: 'hello',
          workspaceRoot: workspace,
          metadata: [] as unknown as Record<string, unknown>,
        }),
      'INVALID_CONFIG'
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectRuntimeError(
      () =>
        validateTurnInput({
          prompt: 'hello',
          workspaceRoot: workspace,
          metadata: circular,
        }),
      'INVALID_CONFIG'
    );
  });
});
