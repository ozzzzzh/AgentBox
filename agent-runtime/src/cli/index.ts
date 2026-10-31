import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runEval } from '../eval/runner.js';
import { createRuntime } from '../runtime/factory.js';
import type { RuntimeConfig } from '../types.js';
import {
  parseArgs,
  USAGE,
  type CliCommand,
  type EvalOptions,
  type RunOptions,
} from './args.js';
import { buildCliRuntimeConfig } from './config.js';
import { JsonlWriter, readJsonlFile, type JsonlRecord } from './jsonl.js';

import { runWithRuntime } from './run.js';
export { runWithRuntime } from './run.js';
export type { RunCoreOptions, RunCoreResult } from './run.js';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function readPrompt(options: RunOptions): string {
  if (options.prompt !== undefined) return options.prompt;
  if (options.promptFile === undefined) {
    throw new Error('prompt is required');
  }
  const prompt = readFileSync(options.promptFile, 'utf8');
  if (prompt.trim() === '') throw new Error('prompt file is empty');
  return prompt;
}

async function runCommand(options: RunOptions): Promise<number> {
  let prompt: string;
  let config: RuntimeConfig;
  try {
    prompt = readPrompt(options);
    config = buildCliRuntimeConfig(options);
  } catch (error) {
    process.stderr.write(`agentbox: ${errorMessage(error)}\n`);
    return 2;
  }

  const runtime = createRuntime(config);
  const writer = new JsonlWriter(options.out);
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);

  try {
    const result = await runWithRuntime(
      runtime,
      {
        prompt,
        workspaceRoot: config.workspaceRoot,
        ...(options.context !== undefined ? { context: options.context } : {}),
        ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
        approval: options.approval,
        ...(config.limits !== undefined
          ? {
              limits: {
                ...(config.limits.turnTimeoutMs !== undefined
                  ? { turnTimeoutMs: config.limits.turnTimeoutMs }
                  : {}),
                ...(config.limits.maxSteps !== undefined
                  ? { maxSteps: config.limits.maxSteps }
                  : {}),
              },
            }
          : {}),
        signal: controller.signal,
      },
      writer
    );

    if (result.ok) return 0;
    return result.reason === 'cancelled' ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    await writer.close();
  }
}

async function evalCommand(options: EvalOptions): Promise<number> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(
    options.outDir ?? join('eval', 'results', timestamp)
  );
  const turnTimeoutMs = options.turnTimeoutMs ?? 180_000;
  const maxSteps = options.maxSteps ?? 30;

  try {
    const report = await runEval({
      taskFile: resolve(options.tasks),
      outDir,
      runtime: options.runtime,
      ...(options.model !== undefined ? { model: options.model } : {}),
      approval: options.approval,
      limits: { turnTimeoutMs, maxSteps },
      ...(options.only !== undefined ? { only: options.only } : {}),
      createRuntime: (task, workspaceRoot) => {
        const runOptions: RunOptions = {
          runtime: options.runtime,
          workspace: workspaceRoot,
          prompt: task.prompt,
          ...(options.provider !== undefined
            ? { provider: options.provider }
            : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.baseUrl !== undefined
            ? { baseUrl: options.baseUrl }
            : {}),
          ...(options.apiKeyEnv !== undefined
            ? { apiKeyEnv: options.apiKeyEnv }
            : {}),
          ...(options.envFile !== undefined
            ? { envFile: options.envFile }
            : {}),
          ...(options.home !== undefined ? { home: options.home } : {}),
          ...(options.command !== undefined
            ? { command: options.command }
            : {}),
          ...(options.approvalPolicy !== undefined
            ? { approvalPolicy: options.approvalPolicy }
            : {}),
          ...(options.permissions !== undefined
            ? { permissions: options.permissions }
            : {}),
          ...(options.autoSetupSandbox !== undefined
            ? { autoSetupSandbox: options.autoSetupSandbox }
            : {}),
          turnTimeoutMs,
          maxSteps,
          taskId: task.id,
          approval: task.approval ?? options.approval,
        };
        return createRuntime(buildCliRuntimeConfig(runOptions));
      },
    });

    process.stdout.write(
      `agentbox eval: ${report.metrics.passed}/${report.metrics.total} passed ` +
        `(${(report.metrics.successRate * 100).toFixed(1)}%)\n` +
        `report: ${join(outDir, 'report.md')}\n`
    );
    return 0;
  } catch (error) {
    process.stderr.write(`agentbox: ${errorMessage(error)}\n`);
    return 2;
  }
}

function summarizeReplay(records: JsonlRecord[]): JsonlRecord {
  const counts: Record<string, number> = {};
  let turns = 0;
  let summaries = 0;
  let errors = 0;
  for (const record of records) {
    const type = typeof record.type === 'string' ? record.type : 'unknown';
    counts[type] = (counts[type] ?? 0) + 1;
    if (type === 'turn.start') turns += 1;
    if (type === 'summary') summaries += 1;
    if (type === 'error') errors += 1;
  }
  return {
    records: records.length,
    turns,
    summaries,
    errors,
    types: counts,
  };
}

function replayCommand(input: string): number {
  try {
    const records = readJsonlFile(input);
    process.stdout.write(`${JSON.stringify(summarizeReplay(records), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`agentbox: ${errorMessage(error)}\n`);
    return 2;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let command: CliCommand;
  try {
    command = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`agentbox: ${errorMessage(error)}\n`);
    return 2;
  }

  if (command.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command.kind === 'replay') {
    return replayCommand(command.options.input);
  }
  if (command.kind === 'eval') {
    return evalCommand(command.options);
  }
  return runCommand(command.options);
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
