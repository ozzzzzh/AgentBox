/**
 * Consumer contract example.
 *
 * This file is type-checked with `npm run typecheck:examples`. The runnable
 * FakeRuntime smoke is `npm run example:fake`.
 */
import {
  createRuntime,
  DEFAULT_LIMITS,
  type AgentEvent,
  type RuntimeConfig,
} from '@agentbox/runtime';
import { FakeRuntime } from '@agentbox/runtime/testing';

/** A real consumer creates a runtime from config; exactly one adapter is used. */
export function createCodexRuntime(config: RuntimeConfig) {
  return createRuntime(config);
}

export async function runFakeDemo(): Promise<AgentEvent[]> {
  const runtime = new FakeRuntime({
    defaultScript: [
      { type: 'text', text: 'hello from FakeRuntime\n' },
      {
        type: 'tool',
        callId: 'c1',
        name: 'read_file',
        args: { path: 'README.md' },
        ok: true,
        result: 'fake content',
      },
    ],
  });

  const events: AgentEvent[] = [];
  runtime.onEvent((event) => events.push(event));

  await runtime.start();
  const handle = await runtime.startTurn({
    prompt: 'hello',
    workspaceRoot: process.cwd(),
    limits: { ...DEFAULT_LIMITS, turnTimeoutMs: 5_000 },
  });

  await new Promise<void>((resolve) => {
    const off = runtime.onEvent((event) => {
      if (event.type === 'turn.end' && event.turnId === handle.turnId) {
        off();
        resolve();
      }
    });
  });

  await runtime.stop();
  return events;
}
