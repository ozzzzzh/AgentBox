import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCliRuntimeConfig, parseEnvFile } from '../../src/cli/config.js';
import type { RunOptions } from '../../src/cli/args.js';

let dir: string;
let envFile: string;
let emptyEnvFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-cli-config-'));
  envFile = join(dir, '.env');
  writeFileSync(envFile, 'DEEPSEEK_API_KEY=sk-test\n');
  emptyEnvFile = join(dir, 'empty.env');
  writeFileSync(emptyEnvFile, '');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    runtime: 'codex',
    workspace: '.',
    prompt: 'x',
    provider: 'deepseek',
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    envFile,
    home: join(dir, 'home'),
    approval: 'deny',
    ...overrides,
  };
}

describe('CLI config', () => {
  it('parses env files', () => {
    expect(parseEnvFile('A=1\n# x\nexport B="two"\n')).toEqual({
      A: '1',
      B: 'two',
    });
  });

  it('resolves workspace/home to absolute paths and passes the key only via env', () => {
    const config = buildCliRuntimeConfig(options());
    expect(config.runtime).toBe('codex');
    expect(config.workspaceRoot).toBe(resolve('.'));
    expect(config.codex?.home).toBe(join(dir, 'home'));
    expect(config.codex?.env).toEqual({ DEEPSEEK_API_KEY: 'sk-test' });
    expect(config.codex?.baseUrl).toBe('https://api.deepseek.com');
    expect(config.codex?.wireApi).toBe('responses');
  });

  it('rejects a missing key for a custom provider', () => {
    expect(() =>
      buildCliRuntimeConfig(options({ envFile: emptyEnvFile }))
    ).toThrow(/missing API key/);
  });
});
