import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { createRuntime, type AgentRuntime, type Limits } from '@agentbox/runtime';
import { FakeRuntime, type FakeStep } from '@agentbox/runtime/testing';
import { DEFAULT_DENY_WRITE } from './file-policy';
import type { LoopDetectorOptions } from './loop-detector';
import { readProjectInstructions } from './project-instructions';
import {
  buildCodexRuntimeConfig,
  readEnvValue,
  type ModelSettings,
} from './settings';
import {
  limitsForTaskProfile,
  normalizeTaskProfile,
} from './task-profile';

const DEMO_SCRIPT: FakeStep[] = [
  { type: 'text', text: '[fake] AgentBox walking skeleton\n' },
  {
    type: 'tool',
    callId: 'c-read',
    name: 'read_file',
    args: { path: 'README.md' },
    ok: true,
    result: 'README.md (simulated content)',
  },
  { type: 'file', path: 'README.md' },
  {
    type: 'approval',
    callId: 'c-shell',
    name: 'run_shell',
    args: { command: 'rm -rf ./dist', cwd: '.' },
    denyResult: 'denied by user',
  },
  { type: 'delay', ms: 2_000 },
  { type: 'text', text: '[fake] done.\n' },
];

export interface AgentRuntimeBundle {
  runtime: AgentRuntime;
  limits: Partial<Limits>;
  signature: string;
  runtimeId: string;
  modelLabel: string;
  providerLabel?: string;
  projectInstructionsPath?: string;
  projectInstructionsTruncated?: boolean;
}

/** File write policy patterns configured by the user. */
export function readDenyWritePatterns(): string[] {
  const config = vscode.workspace.getConfiguration('agentbox');
  const value = config.get<string[]>('files.denyWrite', DEFAULT_DENY_WRITE);
  if (!Array.isArray(value)) return [...DEFAULT_DENY_WRITE];
  return value.filter((item): item is string => typeof item === 'string');
}

function configuredValue<T>(
  config: vscode.WorkspaceConfiguration,
  key: string
): T | undefined {
  if (typeof config.inspect !== 'function') return undefined;
  const inspected = config.inspect<T>(key);
  return (
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue
  );
}

export function readLimits(): Partial<Limits> {
  const config = vscode.workspace.getConfiguration('agentbox');
  const profile = normalizeTaskProfile(
    config.get<string>('taskProfile', 'code')
  );
  const limits = limitsForTaskProfile(profile);

  // Explicit user limits override the selected task profile.
  const timeout = configuredValue<number>(config, 'limits.turnTimeoutMs');
  if (typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0) {
    limits.turnTimeoutMs = timeout;
  }

  const maxSteps = configuredValue<number>(config, 'limits.maxSteps');
  if (typeof maxSteps === 'number' && Number.isInteger(maxSteps) && maxSteps > 0) {
    limits.maxSteps = maxSteps;
  }

  return limits;
}

export function readLoopDetectionOptions(): LoopDetectorOptions | undefined {
  const config = vscode.workspace.getConfiguration('agentbox');
  if (!config.get<boolean>('loopDetection.enabled', true)) return undefined;
  const maxRepeatedFailures = config.get<number>(
    'loopDetection.maxRepeatedFailures',
    2
  );
  const maxConsecutiveFailures = config.get<number>(
    'loopDetection.maxConsecutiveFailures',
    4
  );
  return {
    maxRepeatedFailures:
      Number.isInteger(maxRepeatedFailures) && maxRepeatedFailures >= 2
        ? maxRepeatedFailures
        : 2,
    maxConsecutiveFailures:
      Number.isInteger(maxConsecutiveFailures) && maxConsecutiveFailures >= 2
        ? maxConsecutiveFailures
        : 4,
  };
}

export function readModelSettings(): ModelSettings {
  const config = vscode.workspace.getConfiguration('agentbox');
  const scope = config.get<string>('codex.scope', 'external');
  const approvalPolicy = config.get<string>('codex.approvalPolicy', 'on-request');

  return {
    provider: config.get<string>('codex.provider', 'deepseek'),
    model: config.get<string>('codex.model', 'deepseek-flash'),
    baseUrl: config.get<string>('codex.baseUrl', 'https://api.deepseek.com'),
    apiKeyEnv: config.get<string>('codex.apiKeyEnv', 'DEEPSEEK_API_KEY'),
    scope: scope === 'internal' ? 'internal' : 'external',
    command: config.get<string>('codex.command', 'codex'),
    home: config.get<string>('codex.home', ''),
    approvalPolicy:
      approvalPolicy === 'untrusted' || approvalPolicy === 'never'
        ? approvalPolicy
        : 'on-request',
    permissions: config.get<string>('codex.permissions', ':workspace'),
    autoSetupSandbox: config.get<boolean>('codex.autoSetupSandbox', true),
    extraInstructions: config.get<string>('codex.extraInstructions', ''),
  };
}

export function secretKey(provider: string): string {
  return `agentbox.apiKey.${provider}`;
}

async function resolveApiKey(
  context: vscode.ExtensionContext,
  settings: ModelSettings,
  workspaceRoot: string
): Promise<string | undefined> {
  const stored = await context.secrets.get(secretKey(settings.provider));
  if (stored !== undefined && stored.trim() !== '') return stored.trim();

  const fromProcess = process.env[settings.apiKeyEnv];
  if (fromProcess !== undefined && fromProcess.trim() !== '') {
    return fromProcess.trim();
  }

  const envFile = vscode.workspace
    .getConfiguration('agentbox')
    .get<string>('envFile', '')
    .trim();
  if (envFile !== '') {
    const resolved = envFile.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
    const path = isAbsolute(resolved) ? resolved : resolve(workspaceRoot, resolved);
    if (existsSync(path)) {
      const value = readEnvValue(readFileSync(path, 'utf8'), settings.apiKeyEnv);
      if (value !== undefined) return value;
    }
  }

  return undefined;
}

function resolveHome(
  context: vscode.ExtensionContext,
  settings: ModelSettings,
  workspaceRoot: string
): string {
  const configured = settings.home.trim();
  const home =
    configured === ''
      ? join(context.globalStorageUri.fsPath, 'codex-home')
      : isAbsolute(configured)
        ? configured
        : resolve(workspaceRoot, configured);
  mkdirSync(home, { recursive: true });
  return home;
}

async function acknowledgeExternalProvider(
  context: vscode.ExtensionContext,
  settings: ModelSettings
): Promise<void> {
  if (settings.scope !== 'external') return;

  const key = `agentbox.externalAck.${settings.provider}.${settings.baseUrl}`;
  if (context.globalState.get<boolean>(key)) return;

  const choice = await vscode.window.showWarningMessage(
    'AgentBox is configured to use an external model provider',
    {
      modal: true,
      detail:
        `${settings.provider} (${settings.baseUrl}) will receive prompts and tool output. ` +
        'Do not send secret-level source or business data. Continue?',
    },
    'Continue',
    'Cancel'
  );
  if (choice !== 'Continue') {
    throw new Error('External model provider was not acknowledged.');
  }
  await context.globalState.update(key, true);
}

/**
 * Build one runtime instance from current settings. Shared by the command
 * fallback and the webview chat panel.
 */
export async function createAgentRuntime(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<AgentRuntimeBundle> {
  const runtimeId = vscode.workspace
    .getConfiguration('agentbox')
    .get<string>('runtime', 'codex');
  const limits = readLimits();

  if (runtimeId === 'fake') {
    return {
      runtime: new FakeRuntime({
        runtimeId: 'codex',
        defaultScript: DEMO_SCRIPT,
      }),
      limits,
      signature: JSON.stringify({ runtimeId, workspaceRoot, limits }),
      runtimeId,
      modelLabel: 'fake',
    };
  }

  if (runtimeId !== 'codex') {
    throw new Error(`Unsupported runtime: ${runtimeId}`);
  }

  const settings = readModelSettings();
  await acknowledgeExternalProvider(context, settings);

  const apiKey = await resolveApiKey(context, settings, workspaceRoot);
  if (apiKey === undefined) {
    throw new Error(
      `Missing API key for ${settings.provider}. ` +
        'Run "AgentBox: Set API Key" or set agentbox.envFile.'
    );
  }

  const home = resolveHome(context, settings, workspaceRoot);
  const project = readProjectInstructions(workspaceRoot);
  const config = buildCodexRuntimeConfig({
    settings,
    workspaceRoot,
    apiKey,
    home,
    limits,
    ...(project.text !== undefined
      ? { projectInstructions: project.text }
      : {}),
  });

  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const projectHash = createHash('sha256')
    .update(project.text ?? '')
    .digest('hex');

  return {
    runtime: createRuntime(config),
    limits,
    signature: JSON.stringify({
      runtimeId,
      workspaceRoot,
      limits,
      settings,
      keyHash,
      projectHash,
      projectPath: project.path ?? null,
    }),
    runtimeId,
    modelLabel: settings.model,
    providerLabel: settings.provider,
    ...(project.path !== undefined
      ? { projectInstructionsPath: project.path }
      : {}),
    projectInstructionsTruncated: project.truncated,
  };
}
