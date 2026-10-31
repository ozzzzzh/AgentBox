import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events.js';
import { RuntimeError } from '../src/errors.js';
import { TurnGuard, type TurnGuardOptions } from '../src/turn.js';
import type { AgentEvent, ApprovalDecision } from '../src/types.js';

function createGuard(overrides: TurnGuardOptions = {}) {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.on((event) => events.push(event));

  let timeoutCallback: (() => void) | undefined;

  const guard = new TurnGuard('codex', bus, {
    now: () => 1_000,
    setTimer: (callback) => {
      timeoutCallback = callback;
      return { id: 1 };
    },
    clearTimer: () => {
      timeoutCallback = undefined;
    },
    turnIdFactory: () => 't1',
    ...overrides,
  });

  return {
    bus,
    events,
    guard,
    fireTimeout: () => timeoutCallback?.(),
  };
}

function expectRuntimeError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as RuntimeError).name).toBe('RuntimeError');
    expect((error as RuntimeError).code).toBe(code);
    return;
  }
  throw new Error(`expected RuntimeError(${code}) but nothing was thrown`);
}

describe('TurnGuard', () => {
  it('emits turn.start, injects turnId/at, and ends exactly once', () => {
    const { events, guard } = createGuard();
    const context = guard.begin({
      turnTimeoutMs: 5_000,
      metadata: { sessionId: 's1' },
    });

    expect(guard.activeTurnId).toBe('t1');
    expect(events[0]).toMatchObject({
      type: 'turn.start',
      turnId: 't1',
      runtime: 'codex',
      at: 1_000,
      metadata: { sessionId: 's1' },
    });

    context.emit({ type: 'text.delta', text: 'hello' });
    expect(events[1]).toMatchObject({
      type: 'text.delta',
      turnId: 't1',
      at: 1_000,
      text: 'hello',
    });

    context.end('end_turn');
    context.end('error');

    expect(events.filter((event) => event.type === 'turn.end')).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({
      type: 'turn.end',
      turnId: 't1',
      reason: 'end_turn',
    });
    expect(context.ended).toBe(true);
    expect(guard.activeTurnId).toBeNull();
  });

  it('omits metadata when not provided', () => {
    const { events, guard } = createGuard();
    guard.begin({ turnTimeoutMs: 5_000 });

    expect(events[0]).not.toHaveProperty('metadata');
  });

  it('rejects a concurrent begin with TURN_IN_PROGRESS', () => {
    const { guard } = createGuard();
    guard.begin({ turnTimeoutMs: 5_000 });

    expectRuntimeError(
      () => guard.begin({ turnTimeoutMs: 5_000 }),
      'TURN_IN_PROGRESS'
    );
  });

  it('rejects invalid turn timeouts', () => {
    const { guard } = createGuard();

    for (const turnTimeoutMs of [0, -1, 1.5]) {
      expectRuntimeError(
        () => guard.begin({ turnTimeoutMs }),
        'INVALID_ARGUMENT'
      );
    }
  });

  it('does not allow emitting lifecycle events directly', () => {
    const { guard } = createGuard();
    const context = guard.begin({ turnTimeoutMs: 5_000 });

    expectRuntimeError(
      () =>
        context.emit({ type: 'turn.end', reason: 'error' } as never),
      'INVALID_ARGUMENT'
    );
    expectRuntimeError(
      () =>
        context.emit({
          type: 'turn.start',
          runtime: 'codex',
        } as never),
      'INVALID_ARGUMENT'
    );
  });

  it('drops late events after turn.end', () => {
    const { events, guard } = createGuard();
    const context = guard.begin({ turnTimeoutMs: 5_000 });

    context.end('end_turn');
    const count = events.length;
    context.emit({ type: 'text.delta', text: 'late' });

    expect(events).toHaveLength(count);
  });

  it('emits error(TIMEOUT) and turn.end(error) on timeout', () => {
    const { events, guard, fireTimeout } = createGuard();
    const context = guard.begin({ turnTimeoutMs: 50 });

    fireTimeout();

    expect(context.ended).toBe(true);
    expect(
      events.find(
        (event) => event.type === 'error' && event.turnId === 't1'
      )
    ).toMatchObject({ code: 'TIMEOUT' });
    expect(events.filter((event) => event.type === 'turn.end')).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({
      type: 'turn.end',
      reason: 'error',
    });
  });

  it('routes approval decisions exactly once', async () => {
    const { events, guard } = createGuard();
    const context = guard.begin({ turnTimeoutMs: 5_000 });
    const decisions: ApprovalDecision[] = [];

    context.requestApproval(
      { callId: 'c1', name: 'shell', args: { cmd: 'ls' } },
      (decision) => {
        decisions.push(decision);
      }
    );

    expect(events[1]).toMatchObject({
      type: 'approval.request',
      turnId: 't1',
      callId: 'c1',
      name: 'shell',
      args: { cmd: 'ls' },
    });

    await guard.resolveApproval('t1', 'c1', 'deny');
    expect(decisions).toEqual(['deny']);

    await expect(
      guard.resolveApproval('t1', 'c1', 'allow')
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
  });

  it('awaits async approval resolvers', async () => {
    const { guard } = createGuard();
    const context = guard.begin({ turnTimeoutMs: 5_000 });
    let resolved = false;

    context.requestApproval(
      { callId: 'c1', name: 'shell', args: {} },
      async () => {
        await Promise.resolve();
        resolved = true;
      }
    );

    await guard.resolveApproval('t1', 'c1', 'allow');
    expect(resolved).toBe(true);
  });

  it('rejects duplicate approvals for the same callId', () => {
    const { guard } = createGuard();
    const context = guard.begin({ turnTimeoutMs: 5_000 });

    context.requestApproval(
      { callId: 'c1', name: 'shell', args: {} },
      () => undefined
    );
    expectRuntimeError(
      () =>
        context.requestApproval(
          { callId: 'c1', name: 'shell', args: {} },
          () => undefined
        ),
      'INVALID_ARGUMENT'
    );
  });

  it('rejects resolveApproval for a different turn', async () => {
    const { guard } = createGuard();
    guard.begin({ turnTimeoutMs: 5_000 });

    await expect(
      guard.resolveApproval('other', 'c1', 'allow')
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
  });

  it('cancels pending approvals when the turn ends', async () => {
    const { guard } = createGuard();
    const context = guard.begin({ turnTimeoutMs: 5_000 });
    let cancelled = 0;

    context.requestApproval(
      { callId: 'c1', name: 'shell', args: {} },
      () => undefined,
      () => {
        cancelled += 1;
      }
    );

    context.end('cancelled');
    expect(cancelled).toBe(1);

    await expect(
      guard.resolveApproval('t1', 'c1', 'allow')
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
  });

  it('rejects approvals requested after the turn ended', () => {
    const { guard } = createGuard();
    const context = guard.begin({ turnTimeoutMs: 5_000 });
    context.end('end_turn');

    expectRuntimeError(
      () =>
        context.requestApproval(
          { callId: 'c1', name: 'shell', args: {} },
          () => undefined
        ),
      'INVALID_ARGUMENT'
    );
  });
});
