import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  AgentRuntime,
  Limits,
  TurnHandle,
} from '../types.js';

type TurnEndEvent = Extract<AgentEvent, { type: 'turn.end' }>;

/**
 * Hooks an adapter provides so the shared contract suite can drive it.
 *
 * The suite always starts the runtime itself. Implementations may be test
 * doubles (FakeRuntime) or mock-protocol adapters for Codex/OpenCode.
 */
export interface RuntimeContractFixture {
  runtime: AgentRuntime;
  workspaceRoot: string;

  /** A turn that stays active until aborted or timed out. Required. */
  startLongTurn(limits?: Partial<Limits>): Promise<TurnHandle>;

  /** A normal turn that completes on its own. Optional; defaults to startTurn. */
  startNormalTurn?(): Promise<TurnHandle>;

  /** A turn with a tool call that ends with ok=false. Optional. */
  startFailedToolTurn?(): Promise<TurnHandle>;

  /** A turn that requests approval for `callId`. Optional. */
  startApprovalTurn?(): Promise<{ handle: TurnHandle; callId: string }>;

  /** Release adapter-specific resources. Optional. */
  dispose?(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Register the shared runtime contract tests.
 *
 * Every adapter (FakeRuntime, Codex, OpenCode) must pass this suite.
 */
export function runtimeContractSuite(
  name: string,
  createFixture: () =>
    | RuntimeContractFixture
    | Promise<RuntimeContractFixture>
): void {
  describe(`${name} runtime contract`, () => {
    let fixture: RuntimeContractFixture;
    let events: AgentEvent[];
    let unsubscribe: (() => void) | undefined;

    beforeEach(async () => {
      fixture = await createFixture();
      events = [];
      unsubscribe = fixture.runtime.onEvent((event) => {
        events.push(event);
      });
      await fixture.runtime.start();
    });

    afterEach(async () => {
      unsubscribe?.();
      unsubscribe = undefined;
      try {
        await fixture.runtime.stop();
      } catch {
        // stop() must be idempotent; ignore teardown failures here.
      }
      try {
        await fixture.dispose?.();
      } catch {
        // Best-effort cleanup.
      }
    });

    function turnEvents(turnId: string): AgentEvent[] {
      return events.filter((event) => event.turnId === turnId);
    }

    function waitFor(
      predicate: (event: AgentEvent) => boolean,
      timeoutMs = DEFAULT_TIMEOUT_MS
    ): Promise<AgentEvent> {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);

      return new Promise<AgentEvent>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const off = fixture.runtime.onEvent((event) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          off();
          resolve(event);
        });
        timer = setTimeout(() => {
          off();
          reject(new Error(`timed out after ${timeoutMs}ms waiting for event`));
        }, timeoutMs);
      });
    }

    function waitForTurnEnd(
      turnId: string,
      timeoutMs = DEFAULT_TIMEOUT_MS
    ): Promise<TurnEndEvent> {
      return waitFor(
        (event) => event.type === 'turn.end' && event.turnId === turnId,
        timeoutMs
      ) as Promise<TurnEndEvent>;
    }

    async function startNormal(): Promise<TurnHandle> {
      if (fixture.startNormalTurn !== undefined) {
        return fixture.startNormalTurn();
      }
      return fixture.runtime.startTurn({
        prompt: 'contract test',
        workspaceRoot: fixture.workspaceRoot,
      });
    }

    it('start() and stop() are idempotent', async () => {
      await fixture.runtime.start();
      await fixture.runtime.stop();
      await fixture.runtime.stop();
    });

    it('emits turn.start first and exactly one turn.end', async () => {
      const handle = await startNormal();
      const end = await waitForTurnEnd(handle.turnId);
      const forTurn = turnEvents(handle.turnId);

      expect(forTurn[0]).toMatchObject({
        type: 'turn.start',
        turnId: handle.turnId,
        runtime: fixture.runtime.id,
      });
      expect(forTurn.filter((event) => event.type === 'turn.end')).toHaveLength(
        1
      );
      expect(forTurn[forTurn.length - 1]).toBe(end);
    });

    it('rejects a concurrent turn with TURN_IN_PROGRESS', async () => {
      const first = await fixture.startLongTurn({ turnTimeoutMs: 2_000 });

      await expect(
        fixture.runtime.startTurn({
          prompt: 'second turn',
          workspaceRoot: fixture.workspaceRoot,
        })
      ).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS' });

      await fixture.runtime.abort(first.turnId);
      await waitForTurnEnd(first.turnId);
    });

    it('keeps tool.start/tool.end paired on failure', async (ctx) => {
      const startFailedTool = fixture.startFailedToolTurn;
      if (startFailedTool === undefined) {
        ctx.skip();
        return;
      }

      const handle = await startFailedTool();
      await waitForTurnEnd(handle.turnId);

      const starts = events.filter(
        (event) =>
          event.type === 'tool.start' && event.turnId === handle.turnId
      );
      const ends = events.filter(
        (event) => event.type === 'tool.end' && event.turnId === handle.turnId
      );

      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      if (starts[0].type !== 'tool.start' || ends[0].type !== 'tool.end') {
        throw new Error('unexpected event types');
      }
      expect(ends[0].callId).toBe(starts[0].callId);
      expect(ends[0].ok).toBe(false);
      expect(ends[0].result.length).toBeGreaterThan(0);
    });

    it('stops within 5 seconds on abort and emits cancelled', async () => {
      const handle = await fixture.startLongTurn({ turnTimeoutMs: 10_000 });
      const startedAt = Date.now();

      await fixture.runtime.abort(handle.turnId);
      const end = await waitForTurnEnd(handle.turnId);

      expect(end.reason).toBe('cancelled');
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    });

    it('routes approval decisions and rejects unknown approvals', async (ctx) => {
      const startApproval = fixture.startApprovalTurn;
      if (startApproval === undefined) {
        ctx.skip();
        return;
      }

      const { handle, callId } = await startApproval();
      await waitFor(
        (event) =>
          event.type === 'approval.request' &&
          event.turnId === handle.turnId &&
          event.callId === callId
      );

      await expect(
        fixture.runtime.resolveApproval(handle.turnId, 'missing', 'allow')
      ).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });

      await fixture.runtime.resolveApproval(handle.turnId, callId, 'deny');
      const end = await waitForTurnEnd(handle.turnId);

      expect(['end_turn', 'policy_denied']).toContain(end.reason);
      const toolEnd = events.find(
        (event) => event.type === 'tool.end' && event.callId === callId
      );
      if (toolEnd !== undefined && toolEnd.type === 'tool.end') {
        expect(toolEnd.ok).toBe(false);
        expect(toolEnd.result.length).toBeGreaterThan(0);
      }
    });

    it('times out with error(TIMEOUT) and turn.end(error)', async () => {
      const handle = await fixture.startLongTurn({ turnTimeoutMs: 50 });
      const end = await waitForTurnEnd(handle.turnId, 2_000);

      expect(end.reason).toBe('error');
      expect(
        events.some(
          (event) =>
            event.type === 'error' &&
            event.turnId === handle.turnId &&
            event.code === 'TIMEOUT'
        )
      ).toBe(true);
    });

    it('drops events after turn.end', async () => {
      const handle = await startNormal();
      await waitForTurnEnd(handle.turnId);
      const countAtEnd = turnEvents(handle.turnId).length;

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 80);
      });

      expect(turnEvents(handle.turnId)).toHaveLength(countAtEnd);
    });

    it('stops delivering events after unsubscribe', async () => {
      const seen: AgentEvent[] = [];
      const off = fixture.runtime.onEvent((event) => {
        seen.push(event);
      });
      off();

      const handle = await startNormal();
      await waitForTurnEnd(handle.turnId);

      expect(seen).toHaveLength(0);
    });
  });
}
