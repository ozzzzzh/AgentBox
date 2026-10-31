import { RuntimeError } from '../errors.js';
import type {
  AgentEvent,
  AgentRuntime,
  StopReason,
  TurnHandle,
} from '../types.js';
import type { JsonlWriter } from './jsonl.js';

export interface RunCoreResult {
  ok: boolean;
  reason: StopReason | 'error' | 'not_started';
  steps: number;
  toolErrors: number;
  durationMs: number;
  events: number;
  /** Concatenated text.delta output, used by eval checks. */
  text: string;
  approvals: number;
  firstTokenMs: number | null;
}

export interface RunCoreOptions {
  prompt: string;
  workspaceRoot: string;
  context?: string;
  taskId?: string;
  approval: 'allow' | 'deny';
  limits?: {
    turnTimeoutMs?: number;
    maxSteps?: number;
  };
  signal?: AbortSignal;
}

type TurnEndEvent = Extract<AgentEvent, { type: 'turn.end' }>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Drive one turn and write every normalized event to JSONL.
 * Used by `run` and the eval harness.
 */
export async function runWithRuntime(
  runtime: AgentRuntime,
  options: RunCoreOptions,
  writer: JsonlWriter
): Promise<RunCoreResult> {
  const startedAt = Date.now();
  let steps = 0;
  let toolErrors = 0;
  let eventCount = 0;
  let ended: TurnEndEvent | null = null;
  let handle: TurnHandle | null = null;
  let aborted = false;
  let text = '';
  let approvals = 0;
  let firstTokenMs: number | null = null;
  const meta = options.taskId !== undefined ? { taskId: options.taskId } : undefined;

  let resolveEnd!: (event: TurnEndEvent) => void;
  const endPromise = new Promise<TurnEndEvent>((resolve) => {
    resolveEnd = resolve;
  });

  const off = runtime.onEvent((event) => {
    eventCount += 1;
    writer.writeEvent(event, meta);
    if (event.type === 'text.delta') {
      text += event.text;
      if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
    }
    if (event.type === 'tool.start') steps += 1;
    if (event.type === 'tool.end' && !event.ok) toolErrors += 1;
    if (event.type === 'approval.request') {
      approvals += 1;
      void runtime
        .resolveApproval(event.turnId, event.callId, options.approval)
        .catch((error: unknown) => {
          writer.writeRecord({
            type: 'approval_error',
            ...(meta ?? {}),
            code: error instanceof RuntimeError ? error.code : 'ERROR',
            message: errorMessage(error),
          });
        });
    }
    if (event.type === 'turn.end' && ended === null) {
      ended = event;
      resolveEnd(event);
    }
  });

  const onAbort = (): void => {
    aborted = true;
    if (handle !== null) {
      void runtime.abort(handle.turnId).catch(() => undefined);
    }
  };
  options.signal?.addEventListener('abort', onAbort);

  try {
    await runtime.start();
    handle = await runtime.startTurn({
      prompt: options.prompt,
      workspaceRoot: options.workspaceRoot,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(meta !== undefined ? { metadata: meta } : {}),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
    });
    if (aborted) {
      void runtime.abort(handle.turnId).catch(() => undefined);
    }

    const end = await endPromise;
    const result: RunCoreResult = {
      ok: end.reason === 'end_turn',
      reason: end.reason,
      steps,
      toolErrors,
      durationMs: Date.now() - startedAt,
      events: eventCount,
      text,
      approvals,
      firstTokenMs,
    };
    writer.writeRecord({
      type: 'summary',
      ...(meta ?? {}),
      runtime: runtime.id,
      ok: result.ok,
      reason: result.reason,
      steps: result.steps,
      toolErrors: result.toolErrors,
      durationMs: result.durationMs,
      events: result.events,
      approvals: result.approvals,
      firstTokenMs: result.firstTokenMs,
    });
    return result;
  } catch (error) {
    const result: RunCoreResult = {
      ok: false,
      reason: 'error',
      steps,
      toolErrors,
      durationMs: Date.now() - startedAt,
      events: eventCount,
      text,
      approvals,
      firstTokenMs,
    };
    writer.writeRecord({
      type: 'error',
      ...(meta ?? {}),
      code: error instanceof RuntimeError ? error.code : 'ERROR',
      message: errorMessage(error),
    });
    writer.writeRecord({
      type: 'summary',
      ...(meta ?? {}),
      runtime: runtime.id,
      ok: false,
      reason: 'error',
      steps: result.steps,
      toolErrors: result.toolErrors,
      durationMs: result.durationMs,
      events: result.events,
      approvals: result.approvals,
      firstTokenMs: result.firstTokenMs,
    });
    return result;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    off();
    try {
      await runtime.stop();
    } catch {
      // stop() is best effort during teardown.
    }
  }
}

