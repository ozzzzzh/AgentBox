import { describe, expect, it } from 'vitest';
import {
  buildCodexRuntimeConfig,
  buildDeveloperInstructions,
  parseEnvFile,
  readEnvValue,
  type ModelSettings,
} from '../src/settings';

const settings: ModelSettings = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  scope: 'external',
  command: 'codex',
  home: '',
  approvalPolicy: 'on-request',
  permissions: ':workspace',
  autoSetupSandbox: true,
  extraInstructions: '',
};

describe('parseEnvFile', () => {
  it('parses comments, blanks, export and quoted values', () => {
    const env = parseEnvFile(
      [
        '# comment',
        '',
        'DEEPSEEK_API_KEY=sk-test',
        'export MODEL_NAME="deepseek-flash"',
        "OTHER='a=b c'",
        'INVALID LINE',
        '1BAD=x',
        'EMPTY=',
      ].join('\n')
    );

    expect(env.DEEPSEEK_API_KEY).toBe('sk-test');
    expect(env.MODEL_NAME).toBe('deepseek-flash');
    expect(env.OTHER).toBe('a=b c');
    expect(env['INVALID LINE']).toBeUndefined();
    expect(env['1BAD']).toBeUndefined();
    expect(env.EMPTY).toBe('');
  });

  it('reads a specific key and treats empty as missing', () => {
    const content = 'DEEPSEEK_API_KEY=sk-test\nEMPTY=\n';
    expect(readEnvValue(content, 'DEEPSEEK_API_KEY')).toBe('sk-test');
    expect(readEnvValue(content, 'EMPTY')).toBeUndefined();
    expect(readEnvValue(content, 'MISSING')).toBeUndefined();
  });
});

describe('buildDeveloperInstructions', () => {
  it('adds PowerShell and file-hygiene guidance on Windows', () => {
    const text = buildDeveloperInstructions('win32', 'Prefer TypeScript.');

    expect(text).toContain('PowerShell 5.1');
    expect(text).toContain('Set-Content -Encoding UTF8');
    expect(text).toContain('Do not create files such as `*.patch`');
    expect(text).toContain('.chrome-profile');
    expect(text).toContain('Search/read the relevant files before editing');
    expect(text).toContain('Never claim success without');
    expect(text).toContain('Never revert');
    expect(text).toContain('Prefer TypeScript.');
  });

  it('places project instructions before user extra instructions', () => {
    const text = buildDeveloperInstructions(
      'win32',
      'EXTRA_MARKER',
      'PROJECT_MARKER'
    );

    expect(text).toContain('Project instructions (AGENTS.md / AgentBox.md)');
    expect(text).toContain('must not');
    expect(text.indexOf('PROJECT_MARKER')).toBeLessThan(
      text.indexOf('EXTRA_MARKER')
    );
  });

  it('uses POSIX guidance on other platforms', () => {
    const text = buildDeveloperInstructions('linux', '');

    expect(text).toContain('POSIX sh/bash');
    expect(text).not.toContain('PowerShell 5.1');
  });
});

describe('buildCodexRuntimeConfig', () => {
  it('builds a Codex config with provider and secret env', () => {
    const config = buildCodexRuntimeConfig({
      settings,
      workspaceRoot: 'D:\\work',
      apiKey: 'sk-test',
      home: 'D:\\state\\codex-home',
      limits: { turnTimeoutMs: 1234 },
      projectInstructions: 'Use the repo test command.',
    });

    expect(config.runtime).toBe('codex');
    expect(config.limits).toEqual({ turnTimeoutMs: 1234 });
    expect(config.codex).toMatchObject({
      command: 'codex',
      model: 'deepseek-flash',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      wireApi: 'responses',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      home: 'D:\\state\\codex-home',
      scope: 'external',
      approvalPolicy: 'on-request',
      permissions: ':workspace',
      autoSetupSandbox: true,
    });
    expect(config.codex?.developerInstructions).toContain(
      'You are running inside AgentBox'
    );
    expect(config.codex?.developerInstructions).toContain(
      'Project instructions (AGENTS.md / AgentBox.md)'
    );
    expect(config.codex?.env).toEqual({
      DEEPSEEK_API_KEY: 'sk-test',
    });
  });

  it('rejects missing key/baseUrl/apiKeyEnv', () => {
    expect(() =>
      buildCodexRuntimeConfig({
        settings,
        workspaceRoot: 'D:\\work',
        apiKey: '   ',
        home: 'D:\\state',
      })
    ).toThrow(/API key/);

    expect(() =>
      buildCodexRuntimeConfig({
        settings: { ...settings, baseUrl: '' },
        workspaceRoot: 'D:\\work',
        apiKey: 'sk-test',
        home: 'D:\\state',
      })
    ).toThrow(/baseUrl/);

    expect(() =>
      buildCodexRuntimeConfig({
        settings: { ...settings, apiKeyEnv: '' },
        workspaceRoot: 'D:\\work',
        apiKey: 'sk-test',
        home: 'D:\\state',
      })
    ).toThrow(/apiKeyEnv/);
  });
});
