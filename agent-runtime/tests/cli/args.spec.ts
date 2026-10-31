import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';

describe('CLI args', () => {
  it('parses a minimal run command with defaults', () => {
    const command = parseArgs([
      'run',
      '--workspace',
      'C:\\work',
      '--prompt',
      'hello',
    ]);
    expect(command.kind).toBe('run');
    if (command.kind !== 'run') return;
    expect(command.options).toMatchObject({
      runtime: 'codex',
      workspace: 'C:\\work',
      prompt: 'hello',
      approval: 'deny',
    });
  });

  it('parses provider, model and = syntax', () => {
    const command = parseArgs([
      'run',
      '--workspace=C:\\work',
      '--prompt-file=prompt.txt',
      '--runtime=codex',
      '--provider=deepseek',
      '--model=deepseek-flash',
      '--base-url=https://api.deepseek.com',
      '--api-key-env=DEEPSEEK_API_KEY',
      '--env-file=.env',
      '--approval=allow',
      '--max-steps=24',
      '--no-auto-setup-sandbox',
    ]);
    expect(command.kind).toBe('run');
    if (command.kind !== 'run') return;
    expect(command.options).toMatchObject({
      workspace: 'C:\\work',
      promptFile: 'prompt.txt',
      runtime: 'codex',
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      envFile: '.env',
      approval: 'allow',
      maxSteps: 24,
      autoSetupSandbox: false,
    });
  });

  it('rejects missing workspace and ambiguous prompt', () => {
    expect(() => parseArgs(['run', '--prompt', 'x'])).toThrow(/workspace/);
    expect(() =>
      parseArgs(['run', '--workspace', 'w', '--prompt', 'x', '--prompt-file', 'p'])
    ).toThrow(/exactly one/);
    expect(() => parseArgs(['run', '--workspace', 'w'])).toThrow(/exactly one/);
  });

  it('rejects invalid enums and numbers', () => {
    expect(() =>
      parseArgs(['run', '--workspace', 'w', '--prompt', 'x', '--runtime', 'fake'])
    ).toThrow(/runtime/);
    expect(() =>
      parseArgs(['run', '--workspace', 'w', '--prompt', 'x', '--approval', 'ask'])
    ).toThrow(/approval/);
    expect(() =>
      parseArgs(['run', '--workspace', 'w', '--prompt', 'x', '--max-steps', '0'])
    ).toThrow(/positive integer/);
  });

  it('parses replay and help', () => {
    expect(parseArgs(['replay', '--in', 'events.jsonl'])).toEqual({
      kind: 'replay',
      options: { input: 'events.jsonl' },
    });
    expect(parseArgs(['help'])).toEqual({ kind: 'help' });
    expect(parseArgs([])).toEqual({ kind: 'help' });
  });
});
