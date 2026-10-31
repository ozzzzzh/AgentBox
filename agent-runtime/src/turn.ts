import { randomUUID } from 'node:crypto';
import { RuntimeError } from './errors.js';
import type { EventBus } from './events.js';
import type {
  AgentEvent,
  ApprovalDecision,
  RuntimeId,
  StopReason,
} from './types.js';

type LifecycleEvent =
  | Extract<AgentEvent, { type: 'turn.start' }>
  | Extract<AgentEvent, { type: 'turn.end' }>;

type NonLifecycleEvent = Exclude<AgentEvent, LifecycleEvent>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Event payload accepted by TurnContext.emit(): turnId is injected by the
 * guard and `at` defaults to now. Lifecycle events are managed by the guard.
 */
export type TurnEventInput = DistributiveOmit<
  NonLifecycleEvent,
  'turnId' | 'at'
> & { at?: number };

export interface ApprovalRequest {
  callId: string;
  name: string;
  args: unknown;
}

export type ApprovalResolver = (
  decision: ApprovalDecision
) => void | Promise<void>;

export type ApprovalCancelHandler = () => void;

export interface TurnContext {
  readonly turnId: string;
  readonly ended: boolean;

  /** Emit a normalized event. Late events (after end) are dropped. */
  emit(event: TurnEventInput): void;

  /**
   * Emit `approval.request` and register the resolver that receives the
   * caller's decision. `onCancel` is invoked if the turn ends before a
   * decision is made.
   */
  requestApproval(
    request: ApprovalRequest,
    resolve: ApprovalResolver,
    onCancel?: ApprovalCancelHandler
  ): void;

  /** End the turn exactly once. Later calls are no-ops. */
  end(reason: StopReason): void;
}

export interface BeginTurnOptions {
  turnTimeoutMs: number;
  metadata?: Record<string, unknown>;
}

export interface TurnGuardOptions {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  turnIdFactory?: () => string;
}

function defaultSetTimer(callback: () => void, ms: number): unknown {
  const handle = setTimeout(callback, ms);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref(): void }).unref();
  }
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultTurnIdFactory(): string {
  return `t_${randomUUID()}`;
}

interface PendingApproval {
  resolve: ApprovalResolver;
  onCancel?: ApprovalCancelHandler;
}

class ActiveTurn implements TurnContext {
  private endedInternal = false;
  private timer: unknown = null;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly guard: TurnGuard,
    readonly turnId: string,
    private readonly turnTimeoutMs: number,
    private readonly bus: EventBus,
    private readonly now: () => number,
    private readonly setTimer: (callback: () => void, ms: number) => unknown,
    private readonly clearTimer: (handle: unknown) => void
  ) {}

  get ended(): boolean {
    return this.endedInternal;
  }

  startTimeout(): void {
    if (this.endedInternal) return;
    this.timer = this.setTimer(() => this.onTimeout(), this.turnTimeoutMs);
  }

  emit(event: TurnEventInput): void {
    if (this.endedInternal) return;

    // Runtime guard for untyped JS callers; the type already excludes these.
    const eventType = (event as { type: string }).type;
    if (eventType === 'turn.start' || eventType === 'turn.end') {
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        `${eventType} is managed by TurnGuard; use end() instead`
      );
    }

    const { at, ...rest } = event;
    const fullEvent = {
      ...rest,
      turnId: this.turnId,
      at: at ?? this.now(),
    } as AgentEvent;
    this.bus.emit(fullEvent);
  }

  requestApproval(
    request: ApprovalRequest,
    resolve: ApprovalResolver,
    onCancel?: ApprovalCancelHandler
  ): void {
    if (this.endedInternal) {
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        `turn ${this.turnId} has already ended`
      );
    }
    if (this.pending.has(request.callId)) {
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        `approval ${request.callId} is already pending`
      );
    }

    this.pending.set(request.callId, { resolve, onCancel });
    this.emit({
      type: 'approval.request',
      callId: request.callId,
      name: request.name,
      args: request.args,
    });
  }

  async resolveApproval(
    callId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    if (this.endedInternal) {
      throw new RuntimeError(
        'APPROVAL_NOT_PENDING',
        `turn ${this.turnId} has already ended`
      );
    }

    const pending = this.pending.get(callId);
    if (!pending) {
      throw new RuntimeError(
        'APPROVAL_NOT_PENDING',
        `no pending approval ${callId} for turn ${this.turnId}`
      );
    }

    this.pending.delete(callId);
    await pending.resolve(decision);
  }

  end(reason: StopReason): void {
    if (this.endedInternal) return;

    // Set first so re-entrant end()/emit() calls are no-ops.
    this.endedInternal = true;
    this.stopTimer();

    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      try {
        entry.onCancel?.();
      } catch {
        // Cancellation callbacks must not block turn teardown.
      }
    }

    this.guard.finish(this.turnId);
    this.bus.emit({
      type: 'turn.end',
      turnId: this.turnId,
      reason,
      at: this.now(),
    });
  }

  private onTimeout(): void {
    if (this.endedInternal) return;
    this.emit({
      type: 'error',
      code: 'TIMEOUT',
      message: `turn timed out after ${this.turnTimeoutMs}ms`,
    });
    this.end('error');
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Enforces the turn lifecycle contract:
 *  - one active turn per runtime instance
 *  - turn.start first, turn.end exactly once
 *  - timeout fallback (error + turn.end('error'))
 *  - late events are dropped
 *  - pending approvals are cancelled on end
 */
export class TurnGuard {
  private active: ActiveTurn | null = null;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly turnIdFactory: () => string;

  constructor(
    private readonly runtimeId: RuntimeId,
    private readonly bus: EventBus,
    options: TurnGuardOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.turnIdFactory = options.turnIdFactory ?? defaultTurnIdFactory;
  }

  get activeTurnId(): string | null {
    return this.active?.turnId ?? null;
  }

  begin(options: BeginTurnOptions): TurnContext {
    if (this.active !== null) {
      throw new RuntimeError(
        'TURN_IN_PROGRESS',
        `turn ${this.active.turnId} is still active`
      );
    }
    if (
      typeof options.turnTimeoutMs !== 'number' ||
      !Number.isInteger(options.turnTimeoutMs) ||
      options.turnTimeoutMs <= 0
    ) {
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'turnTimeoutMs must be a positive integer'
      );
    }

    const turnId = this.turnIdFactory();
    if (typeof turnId !== 'string' || turnId === '') {
      throw new RuntimeError('INVALID_ARGUMENT', 'turnIdFactory returned an empty turnId');
    }

    const context = new ActiveTurn(
      this,
      turnId,
      options.turnTimeoutMs,
      this.bus,
      this.now,
      this.setTimer,
      this.clearTimer
    );
    this.active = context;

    const startEvent: AgentEvent = {
      type: 'turn.start',
      turnId,
      runtime: this.runtimeId,
      at: this.now(),
      ...(options.metadata !== undefined
        ? { metadata: options.metadata }
        : {}),
    };
    this.bus.emit(startEvent);
    context.startTimeout();

    return context;
  }

  resolveApproval(
    turnId: string,
    callId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const active = this.active;
    if (active === null || active.turnId !== turnId) {
      return Promise.reject(
        new RuntimeError(
          'APPROVAL_NOT_PENDING',
          `no pending approval for turn ${turnId}`
        )
      );
    }
    return active.resolveApproval(callId, decision);
  }

  /** @internal Called by ActiveTurn.end(); not part of the public API. */
  finish(turnId: string): void {
    if (this.active?.turnId === turnId) {
      this.active = null;
    }
  }
}
