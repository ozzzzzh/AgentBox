import { resolveLimits, validateTurnInput } from '../config.js';
import { RuntimeError } from '../errors.js';
import { EventBus } from '../events.js';
import { TurnGuard, type TurnContext } from '../turn.js';
import type {
  AgentRuntime,
  ApprovalDecision,
  EventListener,
  Limits,
  RuntimeCapabilities,
  RuntimeId,
  StopReason,
  TurnHandle,
  TurnInput,
} from '../types.js';

export type FakeStep =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      callId: string;
      name: string;
      args?: unknown;
      ok?: boolean;
      result?: string;
    }
  | { type: 'file'; path: string }
  | { type: 'error'; code: string; message: string }
  | {
      type: 'approval';
      callId: string;
      name: string;
      args?: unknown;
      denyResult?: string;
    }
  | { type: 'delay'; ms: number };

export interface FakeTurnScript {
  steps: FakeStep[];
  endReason?: StopReason;
}

export interface FakeRuntimeOptions {
  /** Simulated runtime id. Defaults to "codex". */
  runtimeId?: RuntimeId;
  capabilities?: Partial<RuntimeCapabilities>;
  defaultScript?: FakeStep[] | FakeTurnScript;
  /** Initial per-turn scripts, consumed in order. */
  scripts?: Array<FakeStep[] | FakeTurnScript>;
}

const DEFAULT_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  toolEvents: true,
  fileEvents: true,
  approvals: true,
  mcp: false,
};

function normalizeScript(
  script: FakeStep[] | FakeTurnScript
): FakeTurnScript {
  return Array.isArray(script) ? { steps: script } : script;
}

const DEFAULT_SCRIPT: FakeTurnScript = {
  steps: [{ type: 'text', text: 'fake response' }],
};

/**
 * Scriptable in-memory runtime used by unit tests, the contract suite and the
 * V1 VSIX walking skeleton. Test-only: not exported from the package root.
 */
export class FakeRuntime implements AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: RuntimeCapabilities;

  private readonly bus = new EventBus();
  private readonly guard: TurnGuard;
  private readonly defaultScript: FakeTurnScript;
  private readonly scripts: FakeTurnScript[] = [];
  private running = false;
  private active: TurnContext | null = null;

  constructor(options: FakeRuntimeOptions = {}) {
    this.id = options.runtimeId ?? 'codex';
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.defaultScript = options.defaultScript
      ? normalizeScript(options.defaultScript)
      : DEFAULT_SCRIPT;
    for (const script of options.scripts ?? []) {
      this.scripts.push(normalizeScript(script));
    }
    this.guard = new TurnGuard(this.id, this.bus);
  }

  /** Queue a script for the next turn. */
  enqueueTurn(script: FakeStep[] | FakeTurnScript): void {
    this.scripts.push(normalizeScript(script));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
  }

  async startTurn(input: TurnInput): Promise<TurnHandle> {
    if (!this.running) {
      throw new RuntimeError(
        'NOT_RUNNING',
        'FakeRuntime.start() must be called before startTurn()'
      );
    }

    validateTurnInput(input);
    const limits: Limits = resolveLimits(input.limits);
    const context = this.guard.begin({
      turnTimeoutMs: limits.turnTimeoutMs,
      metadata: input.metadata,
    });

    this.active = context;
    const script = this.scripts.shift() ?? this.defaultScript;
    void this.runScript(context, script);

    return { turnId: context.turnId };
  }

  onEvent(listener: EventListener): () => void {
    return this.bus.on(listener);
  }

  resolveApproval(
    turnId: string,
    callId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    return this.guard.resolveApproval(turnId, callId, decision);
  }

  async abort(turnId: string): Promise<void> {
    const active = this.active;
    if (active === null || active.turnId !== turnId) {
      throw new RuntimeError('TURN_NOT_FOUND', `turn ${turnId} is not active`);
    }
    active.end('cancelled');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.active?.end('cancelled');
    this.active = null;
    this.running = false;
    this.scripts.length = 0;
  }

  private async runScript(
    context: TurnContext,
    script: FakeTurnScript
  ): Promise<void> {
    try {
      for (const step of script.steps) {
        if (context.ended) return;

        switch (step.type) {
          case 'text':
            context.emit({ type: 'text.delta', text: step.text });
            break;

          case 'tool': {
            context.emit({
              type: 'tool.start',
              callId: step.callId,
              name: step.name,
              args: step.args ?? {},
            });
            const ok = step.ok ?? true;
            context.emit({
              type: 'tool.end',
              callId: step.callId,
              name: step.name,
              ok,
              result: step.result ?? (ok ? 'ok' : 'failed'),
            });
            break;
          }

          case 'file':
            context.emit({ type: 'file.changed', path: step.path });
            break;

          case 'error':
            context.emit({
              type: 'error',
              code: step.code,
              message: step.message,
            });
            break;

          case 'approval': {
            const decision = await this.waitForDecision(context, step);
            context.emit({
              type: 'tool.end',
              callId: step.callId,
              name: step.name,
              ok: decision === 'allow',
              result:
                decision === 'allow'
                  ? 'approved'
                  : step.denyResult ?? 'denied by policy',
            });
            break;
          }

          case 'delay':
            await this.delay(step.ms, context);
            break;
        }
      }

      context.end(script.endReason ?? 'end_turn');
    } catch (error) {
      if (!context.ended) {
        context.emit({
          type: 'error',
          code:
            error instanceof RuntimeError ? error.code : 'PROTOCOL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        });
        context.end('error');
      }
    } finally {
      if (this.active === context) {
        this.active = null;
      }
    }
  }

  private waitForDecision(
    context: TurnContext,
    step: Extract<FakeStep, { type: 'approval' }>
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve, reject) => {
      let settled = false;

      const finish = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        resolve(decision);
      };
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        reject(
          new RuntimeError(
            'CANCELLED',
            'turn ended before an approval decision was made'
          )
        );
      };

      context.requestApproval(
        {
          callId: step.callId,
          name: step.name,
          args: step.args ?? {},
        },
        finish,
        cancel
      );
    });
  }

  private async delay(ms: number, context: TurnContext): Promise<void> {
    const deadline = Date.now() + Math.max(0, ms);
    while (!context.ended && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(50, remaining));
      });
    }
  }
}

