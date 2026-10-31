import { statSync } from 'node:fs';
import { RuntimeError } from './errors.js';
import {
  DEFAULT_LIMITS,
  type Limits,
  type RuntimeConfig,
  type TurnInput,
} from './types.js';

const LIMIT_KEYS = [
  'maxSteps',
  'maxToolCallsPerTurn',
  'maxOutputCharsPerTool',
  'maxContextTokens',
  'toolTimeoutMs',
  'turnTimeoutMs',
] as const satisfies readonly (keyof Limits)[];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function invalid(message: string, cause?: unknown): RuntimeError {
  return new RuntimeError('INVALID_CONFIG', message, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(
  name: string,
  value: unknown
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${name} must be a non-empty string`);
  }
}

function assertPositiveInteger(
  name: string,
  value: unknown
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer`);
  }
}

function assertWorkspaceRoot(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid('workspaceRoot is required');
  }

  let isDirectory = false;
  try {
    isDirectory = statSync(value).isDirectory();
  } catch (error) {
    throw invalid(`workspaceRoot does not exist: ${value}`, error);
  }
  if (!isDirectory) {
    throw invalid(`workspaceRoot is not a directory: ${value}`);
  }
}

function validateEnv(name: string, value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw invalid(`${name} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === '') {
      throw invalid(`${name} contains an empty key`);
    }
    if (typeof entry !== 'string') {
      throw invalid(`${name}.${key} must be a string`);
    }
  }
}

function validateCodexConfig(value: unknown): void {
  if (!isRecord(value)) {
    throw invalid('codex config must be an object');
  }
  if (value.command !== undefined) {
    assertNonEmptyString('codex.command', value.command);
  }
  if (value.args !== undefined) {
    if (
      !Array.isArray(value.args) ||
      value.args.some((arg) => typeof arg !== 'string')
    ) {
      throw invalid('codex.args must be an array of strings');
    }
  }
  if (value.model !== undefined) {
    assertNonEmptyString('codex.model', value.model);
  }
  if (value.provider !== undefined) {
    assertNonEmptyString('codex.provider', value.provider);
  }
  if (value.baseUrl !== undefined) {
    assertNonEmptyString('codex.baseUrl', value.baseUrl);
  }
  if (value.wireApi !== undefined && value.wireApi !== 'responses') {
    throw invalid('codex.wireApi must be "responses"');
  }
  if (value.apiKeyEnv !== undefined) {
    assertNonEmptyString('codex.apiKeyEnv', value.apiKeyEnv);
  }
  if (value.modelCatalogJson !== undefined) {
    assertNonEmptyString('codex.modelCatalogJson', value.modelCatalogJson);
  }
  if (value.home !== undefined) {
    assertNonEmptyString('codex.home', value.home);
  }
  if (value.scope !== undefined && value.scope !== 'internal' && value.scope !== 'external') {
    throw invalid('codex.scope must be "internal" or "external"');
  }
  if (
    value.approvalPolicy !== undefined &&
    value.approvalPolicy !== 'untrusted' &&
    value.approvalPolicy !== 'on-request' &&
    value.approvalPolicy !== 'never'
  ) {
    throw invalid('codex.approvalPolicy is invalid');
  }
  if (value.permissions !== undefined) {
    assertNonEmptyString('codex.permissions', value.permissions);
  }
  if (value.autoSetupSandbox !== undefined && typeof value.autoSetupSandbox !== 'boolean') {
    throw invalid('codex.autoSetupSandbox must be a boolean');
  }
  validateEnv('codex.env', value.env);
}

function validateOpenCodeConfig(value: unknown): void {
  if (!isRecord(value)) {
    throw invalid('opencode config must be an object');
  }
  if (value.command !== undefined) {
    assertNonEmptyString('opencode.command', value.command);
  }
  if (value.hostname !== undefined) {
    assertNonEmptyString('opencode.hostname', value.hostname);
    if (!LOOPBACK_HOSTS.has(value.hostname)) {
      throw invalid(
        'opencode.hostname must be loopback (127.0.0.1, localhost or ::1)'
      );
    }
  }
  if (value.port !== undefined) {
    if (
      typeof value.port !== 'number' ||
      !Number.isInteger(value.port) ||
      value.port < 0 ||
      value.port > 65535
    ) {
      throw invalid('opencode.port must be an integer between 0 and 65535');
    }
  }
  if (value.model !== undefined) {
    assertNonEmptyString('opencode.model', value.model);
  }
  validateEnv('opencode.env', value.env);
}

/**
 * Resolve effective limits. Later sources override earlier ones.
 * Always returns a fresh object; DEFAULT_LIMITS is never mutated.
 */
export function resolveLimits(
  ...sources: Array<Partial<Limits> | undefined>
): Limits {
  const resolved: Limits = { ...DEFAULT_LIMITS };

  for (const source of sources) {
    if (source === undefined) continue;
    if (!isRecord(source)) {
      throw invalid('limits must be an object');
    }

    for (const [key, value] of Object.entries(source)) {
      if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
        throw invalid(`unknown limit: ${key}`);
      }
      if (value === undefined) continue;
      assertPositiveInteger(`limits.${key}`, value);
      resolved[key as keyof Limits] = value;
    }
  }

  return resolved;
}

/** Effective limits for one turn: config defaults, then turn overrides. */
export function resolveTurnLimits(
  config: RuntimeConfig,
  input: TurnInput
): Limits {
  return resolveLimits(config.limits, input.limits);
}

export function validateRuntimeConfig(config: RuntimeConfig): void {
  if (!isRecord(config)) {
    throw invalid('config must be an object');
  }
  if (config.runtime !== 'codex' && config.runtime !== 'opencode') {
    throw new RuntimeError(
      'INVALID_RUNTIME',
      `Unsupported runtime: ${String(config.runtime)}. Supported: codex, opencode.`
    );
  }

  assertWorkspaceRoot(config.workspaceRoot);
  resolveLimits(config.limits);

  if (config.codex !== undefined) {
    validateCodexConfig(config.codex);
  }
  if (config.opencode !== undefined) {
    validateOpenCodeConfig(config.opencode);
  }
}

export function validateTurnInput(input: TurnInput): void {
  if (!isRecord(input)) {
    throw invalid('turn input must be an object');
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    throw invalid('prompt must be a non-empty string');
  }

  assertWorkspaceRoot(input.workspaceRoot);
  resolveLimits(input.limits);

  if (input.context !== undefined && typeof input.context !== 'string') {
    throw invalid('context must be a string');
  }
  if (input.metadata !== undefined) {
    if (!isRecord(input.metadata)) {
      throw invalid('metadata must be an object');
    }
    try {
      JSON.stringify(input.metadata);
    } catch (error) {
      throw invalid('metadata must be JSON-serializable', error);
    }
  }
}
