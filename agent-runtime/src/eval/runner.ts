import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runWithRuntime } from '../cli/run.js';
import { JsonlWriter } from '../cli/jsonl.js';
import { assertInsideWorkspace } from '../security/paths.js';
import type { AgentRuntime } from '../types.js';
import { runCheck } from './checks.js';
import { computeMetrics } from './metrics.js';
import { renderMarkdown } from './report.js';
import type {
  EvalReport,
  TaskDefinition,
  TaskResult,
} from './types.js';

export interface EvalRunOptions {
  taskFile: string;
  outDir: string;
  runtime: 'codex' | 'opencode';
  model?: string;
  approval: 'allow' | 'deny';
  limits?: {
    maxSteps?: number;
    turnTimeoutMs?: number;
  };
  /** Optional task id filter (repeatable). */
  only?: string[];
  /** Injected by CLI; tests can supply FakeRuntime. */
  createRuntime(task: TaskDefinition, workspaceRoot: string): AgentRuntime;
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

function materialize(workspaceRoot: string, files?: Record<string, string>): void {
  mkdirSync(workspaceRoot, { recursive: true });
  for (const [path, content] of Object.entries(files ?? {})) {
    const absolute = assertInsideWorkspace(workspaceRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

export function loadTasks(taskFile: string): TaskDefinition[] {
  const parsed: unknown = JSON.parse(readFileSync(taskFile, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('task file must contain a JSON array');
  }
  const tasks: TaskDefinition[] = [];
  const seen = new Set<string>();
  for (const [index, value] of parsed.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`task ${index + 1} is not an object`);
    }
    const record = value as Record<string, unknown>;
    const id = record.id;
    const name = record.name;
    const prompt = record.prompt;
    const check = record.check;
    if (typeof id !== 'string' || id === '') {
      throw new Error(`task ${index + 1} has no id`);
    }
    if (seen.has(id)) throw new Error(`duplicate task id: ${id}`);
    seen.add(id);
    if (typeof name !== 'string' || name === '') {
      throw new Error(`task ${id} has no name`);
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new Error(`task ${id} has no prompt`);
    }
    if (typeof check !== 'object' || check === null || Array.isArray(check)) {
      throw new Error(`task ${id} has no check`);
    }
    tasks.push({
      id,
      name,
      prompt,
      check: check as TaskDefinition['check'],
      ...(record.files !== undefined
        ? { files: record.files as Record<string, string> }
        : {}),
      ...(record.approval === 'allow' || record.approval === 'deny'
        ? { approval: record.approval }
        : {}),
      ...(typeof record.limits === 'object' && record.limits !== null
        ? { limits: record.limits as TaskDefinition['limits'] }
        : {}),
    });
  }
  return tasks;
}

function mergeLimits(
  base: EvalRunOptions['limits'],
  task: TaskDefinition['limits']
): EvalRunOptions['limits'] {
  return {
    ...(base ?? {}),
    ...(task ?? {}),
  };
}

export async function runEval(options: EvalRunOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const allTasks = loadTasks(options.taskFile);
  const tasks =
    options.only !== undefined && options.only.length > 0
      ? allTasks.filter((task) => options.only?.includes(task.id))
      : allTasks;

  mkdirSync(options.outDir, { recursive: true });
  const results: TaskResult[] = [];

  for (const task of tasks) {
    const id = safeId(task.id);
    const workDir = join(options.outDir, 'work', id);
    const jsonl = join(options.outDir, `${id}.jsonl`);
    // Deterministic fixtures: reruns must not inherit previous edits.
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });

    let writer: JsonlWriter | undefined;
    try {
      materialize(workDir, task.files);
      writer = new JsonlWriter(jsonl);
      const runtime = options.createRuntime(task, workDir);
      const result = await runWithRuntime(
        runtime,
        {
          prompt: task.prompt,
          workspaceRoot: resolve(workDir),
          taskId: task.id,
          approval: task.approval ?? options.approval,
          ...(mergeLimits(options.limits, task.limits) !== undefined
            ? { limits: mergeLimits(options.limits, task.limits) }
            : {}),
        },
        writer
      );
      const check = runCheck(task.check, {
        workspaceRoot: resolve(workDir),
        text: result.text,
        approvals: result.approvals,
      });
      results.push({
        id: task.id,
        name: task.name,
        ok: result.ok && check.ok,
        turnOk: result.ok,
        reason: result.reason,
        steps: result.steps,
        toolErrors: result.toolErrors,
        approvals: result.approvals,
        durationMs: result.durationMs,
        firstTokenMs: result.firstTokenMs,
        check,
        workDir,
        jsonl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writer?.writeRecord({
        type: 'error',
        taskId: task.id,
        code: 'EVAL_TASK_ERROR',
        message,
      });
      results.push({
        id: task.id,
        name: task.name,
        ok: false,
        turnOk: false,
        reason: 'error',
        steps: 0,
        toolErrors: 0,
        approvals: 0,
        durationMs: 0,
        firstTokenMs: null,
        check: { ok: false, type: task.check.type, detail: message },
        workDir,
        jsonl,
        error: message,
      });
    } finally {
      await writer?.close();
    }
  }

  const finishedAt = new Date().toISOString();
  const report: EvalReport = {
    taskFile: options.taskFile,
    runtime: options.runtime,
    ...(options.model !== undefined ? { model: options.model } : {}),
    startedAt,
    finishedAt,
    metrics: computeMetrics(results),
    tasks: results,
  };

  writeFileSync(
    join(options.outDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    join(options.outDir, 'report.md'),
    renderMarkdown(report),
    'utf8'
  );
  return report;
}
