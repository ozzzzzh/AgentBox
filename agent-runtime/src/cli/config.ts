import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Limits, RuntimeConfig } from '../types.js';
import type { RunOptions } from './args.js';

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function readEnvFile(path: string): Record<string, string> {
  return parseEnvFile(readFileSync(path, 'utf8'));
}

export function buildCliRuntimeConfig(
  options: RunOptions
): RuntimeConfig {
  const envFile = options.envFile
    ? readEnvFile(options.envFile)
    : {};
  const apiKeyEnv = options.apiKeyEnv ?? 'MODEL_API_KEY';
  const apiKey =
    envFile[apiKeyEnv] ?? process.env[apiKeyEnv] ?? undefined;

  if (options.baseUrl !== undefined && (apiKey === undefined || apiKey.trim() === '')) {
    throw new Error(
      `missing API key: set ${apiKeyEnv} in the environment or pass --env-file`
    );
  }

  const limits: Partial<Limits> = {};
  if (options.turnTimeoutMs !== undefined) {
    limits.turnTimeoutMs = options.turnTimeoutMs;
  }
  if (options.maxSteps !== undefined) {
    limits.maxSteps = options.maxSteps;
  }

  const workspaceRoot = resolve(options.workspace);

  if (options.runtime === 'codex') {
    const home = resolve(
      options.home ?? join(tmpdir(), 'agentbox-cli-codex-home')
    );
    mkdirSync(home, { recursive: true });

    return {
      runtime: 'codex',
      workspaceRoot,
      limits,
      codex: {
        command: options.command ?? 'codex',
        model: options.model,
        provider: options.provider ?? (options.baseUrl !== undefined ? 'agentbox' : undefined),
        baseUrl: options.baseUrl,
        wireApi: options.baseUrl !== undefined ? 'responses' : undefined,
        apiKeyEnv,
        home,
        scope: options.baseUrl !== undefined ? 'external' : 'internal',
        approvalPolicy: options.approvalPolicy ?? 'on-request',
        permissions: options.permissions ?? ':workspace',
        autoSetupSandbox: options.autoSetupSandbox ?? true,
        env:
          apiKey !== undefined && apiKey !== ''
            ? { [apiKeyEnv]: apiKey }
            : undefined,
      },
    };
  }

  return {
    runtime: 'opencode',
    workspaceRoot,
    limits,
    opencode: {
      model: options.model,
      hostname: '127.0.0.1',
      port: 0,
      env:
        apiKey !== undefined && apiKey !== ''
          ? { [apiKeyEnv]: apiKey }
          : undefined,
    },
  };
}
