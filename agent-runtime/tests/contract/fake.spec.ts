import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runtimeContractSuite } from '../../src/testing/contract.js';
import { FakeRuntime } from '../../src/testing/fake-runtime.js';
import { createFakeRuntimeContractFixture } from '../../src/testing/fixture.js';
import type { AgentEvent, AgentRuntime } from '../../src/types.js';

const workspaceRoot = mkdtempSync(join(tmpdir(), 'agentbox-contract-'));

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

runtimeContractSuite('FakeRuntime', () =>
  createFakeRuntimeContractFixture({ workspaceRoot })
);

function waitForTurnEnd(
  runtime: AgentRuntime,
  events: AgentEvent[],
  turnId: string
): Promise<void> {
  if (
    events.some((event) => event.type === 'turn.end' && event.turnId === turnId)
  ) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for turn.end'));
    }, 2_000);
    const off = runtime.onEvent((event) => {
      if (event.type === 'turn.end' && event.turnId === turnId) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

describe('FakeRuntime', () => {
  it('emits file.changed and merges capabilities', async () => {
    const runtime = new FakeRuntime({
      capabilities: { mcp: true },
      defaultScript: [{ type: 'file', path: 'src/a.ts' }],
    });
    const events: AgentEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.start();

    const handle = await runtime.startTurn({
      prompt: 'update file',
      workspaceRoot,
    });
    await waitForTurnEnd(runtime, events, handle.turnId);

    expect(runtime.capabilities.mcp).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'file.changed',
        turnId: handle.turnId,
        path: 'src/a.ts',
      })
    );
  });

  it('ends an active turn as cancelled on stop and stays idempotent', async () => {
    const runtime = new FakeRuntime();
    const events: AgentEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.start();

    runtime.enqueueTurn({ steps: [{ type: 'delay', ms: 10_000 }] });
    const handle = await runtime.startTurn({
      prompt: 'long',
      workspaceRoot,
    });

    await runtime.stop();
    await runtime.stop();

    const end = events.find(
      (event) => event.type === 'turn.end' && event.turnId === handle.turnId
    );
    expect(end).toMatchObject({ type: 'turn.end', reason: 'cancelled' });
  });

  it('requires start() before startTurn()', async () => {
    const runtime = new FakeRuntime();

    await expect(
      runtime.startTurn({ prompt: 'x', workspaceRoot })
    ).rejects.toMatchObject({ code: 'NOT_RUNNING' });
  });

  it('rejects abort for an unknown turn', async () => {
    const runtime = new FakeRuntime();
    await runtime.start();

    await expect(runtime.abort('missing')).rejects.toMatchObject({
      code: 'TURN_NOT_FOUND',
    });
  });

  it('rejects approval resolution when nothing is pending', async () => {
    const runtime = new FakeRuntime();
    await runtime.start();

    await expect(
      runtime.resolveApproval('missing', 'call', 'allow')
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
  });
});
