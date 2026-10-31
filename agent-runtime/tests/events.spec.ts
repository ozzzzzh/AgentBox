import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events.js';
import type { AgentEvent } from '../src/types.js';

function turnStart(turnId = 't1'): AgentEvent {
  return { type: 'turn.start', turnId, runtime: 'codex', at: 1 };
}

describe('EventBus', () => {
  it('delivers events to all listeners', () => {
    const bus = new EventBus();
    const first: AgentEvent[] = [];
    const second: AgentEvent[] = [];

    bus.on((event) => first.push(event));
    bus.on((event) => second.push(event));

    const event = turnStart();
    bus.emit(event);

    expect(first).toEqual([event]);
    expect(second).toEqual([event]);
  });

  it('stops delivery after unsubscribe and is idempotent', () => {
    const bus = new EventBus();
    const seen: AgentEvent[] = [];
    const off = bus.on((event) => seen.push(event));

    off();
    off();
    bus.emit(turnStart());

    expect(seen).toHaveLength(0);
  });

  it('isolates listener errors and reports them', () => {
    const errors: unknown[] = [];
    const bus = new EventBus({
      onListenerError: (error) => errors.push(error),
    });
    const seen: AgentEvent[] = [];

    bus.on(() => {
      throw new Error('listener boom');
    });
    bus.on((event) => seen.push(event));

    bus.emit(turnStart());

    expect(seen).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('listener boom');
  });

  it('supports listeners subscribing and unsubscribing during emit', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    let offSecond: (() => void) | undefined;

    bus.on(() => {
      seen.push('first');
      offSecond?.();
    });
    offSecond = bus.on(() => {
      seen.push('second');
    });

    bus.emit(turnStart());
    bus.emit(turnStart());

    // Emit iterates over a snapshot: the in-flight emit still reaches the
    // second listener; unsubscription applies to the next emit.
    expect(seen).toEqual(['first', 'second', 'first']);
  });

  it('clears all listeners', () => {
    const bus = new EventBus();
    const seen: AgentEvent[] = [];
    bus.on((event) => seen.push(event));

    bus.clear();
    bus.emit(turnStart());

    expect(seen).toHaveLength(0);
  });
});
