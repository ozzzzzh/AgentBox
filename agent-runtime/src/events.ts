import type { AgentEvent, EventListener } from './types.js';

export interface EventBusOptions {
  /**
   * Called when a listener throws. Listener errors never propagate to other
   * listeners or to the adapter. Defaults to a no-op.
   */
  onListenerError?: (error: unknown, event: AgentEvent) => void;
}

/**
 * Type-safe event fan-out with listener isolation.
 */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly options: EventBusOptions = {}) {}

  /** Subscribe. Returns an idempotent unsubscribe function. */
  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    // Snapshot so listeners may subscribe/unsubscribe during emit.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.options.onListenerError?.(error, event);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
