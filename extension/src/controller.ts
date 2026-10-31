import { RuntimeError } from '@agentbox/runtime';
import type { ToolLoopDetector } from './loop-detector';
import type {
  AgentEvent,
  AgentRuntime,
  ApprovalDecision,
  Limits,
  StopReason,
  TokenUsageSnapshot,
  TurnHandle,
} from '@agentbox/runtime';

export interface ApprovalPrompt {
  turnId: string;
  callId: string;
  name: string;
  args: unknown;
  /** Extra warning shown on the approval card (e.g. file policy confirm). */
  warning?: string;
}

export interface ApprovalPolicyResult {
  decision: 'allow' | 'deny' | 'confirm';
  reason?: string;
}

export type ApprovalPolicy = (
  prompt: ApprovalPrompt
) => ApprovalPolicyResult;

/**
 * UI boundary for the controller. Implemented by the VS Code shell and by a
 * fake UI in unit tests, so the controller stays headless.
 */
export interface TurnUi {
  appendText(text: string): void;
  appendEventLine(line: string): void;
  requestApproval(prompt: ApprovalPrompt): Promise<ApprovalDecision>;
  setBusy(busy: boolean): void;
  showError(message: string): void;

  // Optional structured hooks. The OutputChannel UI leaves these undefined and
  // keeps using appendEventLine(); the webview UI implements them to render
  // cards instead of plain log lines.
  turnStarted?(turnId: string): void;
  toolStarted?(callId: string, name: string, args: unknown): void;
  toolEnded?(callId: string, name: string, ok: boolean, result: string): void;
  fileChanged?(path: string): void;
  errorEvent?(code: string, message: string): void;
  turnEnded?(reason: StopReason): void;
  approvalRequested?(prompt: ApprovalPrompt): void;
  tokenUsage?(usage: TokenUsageSnapshot): void;
}

export interface RuntimeControllerOptions {
  runtime: AgentRuntime;
  workspaceRoot: string;
  limits?: Partial<Limits>;
  ui: TurnUi;
  approvalPolicy?: ApprovalPolicy;
  loopDetector?: ToolLoopDetector;
}

/**
 * Drives one AgentRuntime instance and renders its normalized events.
 *
 * V1 scope: a single active turn, a streaming output view, approval prompts,
 * and cancellation. No knowledge/Skill/asset logic.
 */
export class RuntimeController {
  private readonly runtime: AgentRuntime;
  private readonly workspaceRoot: string;
  private readonly limits: Partial<Limits> | undefined;
  private readonly ui: TurnUi;
  private readonly approvalPolicy: ApprovalPolicy | undefined;
  private readonly loopDetector: ToolLoopDetector | undefined;
  private loopAbortRequested = false;

  private started = false;
  private startingTurn = false;
  private sawTurnStart = false;
  private activeTurnId: string | null = null;
  private unsubscribe: (() => void) | undefined;

  constructor(options: RuntimeControllerOptions) {
    this.runtime = options.runtime;
    this.workspaceRoot = options.workspaceRoot;
    this.limits = options.limits;
    this.ui = options.ui;
    this.approvalPolicy = options.approvalPolicy;
    this.loopDetector = options.loopDetector;
  }

  get busy(): boolean {
    return this.startingTurn || this.activeTurnId !== null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.runtime.start();
    this.unsubscribe = this.runtime.onEvent((event) => this.handleEvent(event));
    this.started = true;
    this.ui.setBusy(false);
  }

  async runTurn(prompt: string, context?: string): Promise<TurnHandle | null> {
    if (!this.started) {
      this.ui.showError('AgentBox runtime is not started.');
      return null;
    }
    if (this.busy) {
      this.ui.showError(
        'A turn is already running. Cancel it before starting another.'
      );
      return null;
    }

    this.startingTurn = true;
    this.sawTurnStart = false;
    this.ui.setBusy(true);
    this.ui.appendEventLine(`▶ ${truncate(prompt, 160)}`);

    try {
      return await this.runtime.startTurn({
        prompt,
        workspaceRoot: this.workspaceRoot,
        ...(context !== undefined && context !== '' ? { context } : {}),
        ...(this.limits !== undefined ? { limits: this.limits } : {}),
      });
    } catch (error) {
      this.ui.showError(toErrorMessage(error));
      return null;
    } finally {
      this.startingTurn = false;
      if (!this.sawTurnStart) {
        // startTurn failed before emitting turn.start.
        this.ui.setBusy(false);
      }
    }
  }

  async cancel(): Promise<void> {
    const turnId = this.activeTurnId;
    if (turnId === null) {
      this.ui.appendEventLine('no active turn to cancel');
      return;
    }

    try {
      await this.runtime.abort(turnId);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'TURN_NOT_FOUND') {
        this.ui.appendEventLine('turn already ended');
        return;
      }
      this.ui.showError(toErrorMessage(error));
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.started = false;
    this.startingTurn = false;
    this.activeTurnId = null;

    try {
      await this.runtime.stop();
    } catch (error) {
      this.ui.showError(toErrorMessage(error));
    }
    this.ui.setBusy(false);
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'turn.start':
        this.sawTurnStart = true;
        this.activeTurnId = event.turnId;
        this.loopAbortRequested = false;
        this.loopDetector?.reset();
        this.ui.setBusy(true);
        if (this.ui.turnStarted !== undefined) {
          this.ui.turnStarted(event.turnId);
        } else {
          this.ui.appendEventLine('▶ turn started');
        }
        break;

      case 'text.delta':
        this.ui.appendText(event.text);
        break;

      case 'tool.start':
        this.loopDetector?.toolStart(
          event.callId,
          event.name,
          event.args
        );
        if (this.ui.toolStarted !== undefined) {
          this.ui.toolStarted(event.callId, event.name, event.args);
        } else {
          this.ui.appendEventLine(
            `🔧 ${event.name} ${formatArgs(event.args)}`
          );
        }
        break;

      case 'tool.end': {
        if (this.ui.toolEnded !== undefined) {
          this.ui.toolEnded(
            event.callId,
            event.name,
            event.ok,
            event.result
          );
        } else {
          this.ui.appendEventLine(
            `${event.ok ? '✓' : '✗'} ${event.name}: ${truncate(event.result, 200)}`
          );
        }
        if (!this.loopAbortRequested && this.loopDetector !== undefined) {
          const result = this.loopDetector.toolEnd(event.callId, event.ok);
          if (result.loop) {
            this.stopForLoop(
              result.reason ?? '重复的工具调用失败'
            );
          }
        }
        break;
      }

      case 'file.changed':
        if (this.ui.fileChanged !== undefined) {
          this.ui.fileChanged(event.path);
        } else {
          this.ui.appendEventLine(`📝 ${event.path}`);
        }
        break;

      case 'approval.request':
        void this.handleApproval(event);
        break;

      case 'token.usage':
        if (this.ui.tokenUsage !== undefined) {
          this.ui.tokenUsage(event.usage);
        } else {
          this.ui.appendEventLine(
            `tokens: ${event.usage.last.totalTokens} this turn · ` +
              `${event.usage.total.totalTokens} session`
          );
        }
        break;

      case 'error':
        if (this.ui.errorEvent !== undefined) {
          this.ui.errorEvent(event.code, event.message);
        } else {
          this.ui.appendEventLine(
            `⚠ ${event.code}: ${truncate(event.message, 200)}`
          );
        }
        break;

      case 'turn.end':
        this.activeTurnId = null;
        this.loopAbortRequested = false;
        this.loopDetector?.reset();
        this.ui.setBusy(false);
        if (this.ui.turnEnded !== undefined) {
          this.ui.turnEnded(event.reason);
        } else {
          this.ui.appendEventLine(`■ turn ${event.reason}`);
        }
        break;
    }
  }

  private stopForLoop(reason: string): void {
    const turnId = this.activeTurnId;
    if (turnId === null || this.loopAbortRequested) return;
    this.loopAbortRequested = true;
    this.ui.showError(`检测到工具循环，已停止本轮：${reason}`);
    void this.runtime.abort(turnId).catch((error) => {
      this.ui.showError(toErrorMessage(error));
    });
  }

  private async handleApproval(
    event: Extract<AgentEvent, { type: 'approval.request' }>
  ): Promise<void> {
    const prompt: ApprovalPrompt = {
      turnId: event.turnId,
      callId: event.callId,
      name: event.name,
      args: event.args,
    };

    const policy = this.approvalPolicy?.(prompt);
    if (policy?.decision === 'deny') {
      this.ui.appendEventLine(
        `⛔ 已按文件策略拒绝 ${event.name}: ${policy.reason ?? 'blocked'}`
      );
      if (this.activeTurnId !== event.turnId) return;
      try {
        await this.runtime.resolveApproval(event.turnId, event.callId, 'deny');
      } catch (error) {
        if (
          !(
            error instanceof RuntimeError &&
            error.code === 'APPROVAL_NOT_PENDING'
          )
        ) {
          this.ui.showError(toErrorMessage(error));
        }
      }
      return;
    }

    const effectivePrompt: ApprovalPrompt =
      policy?.decision === 'confirm' && policy.reason !== undefined
        ? { ...prompt, warning: policy.reason }
        : prompt;

    if (this.ui.approvalRequested !== undefined) {
      this.ui.approvalRequested(effectivePrompt);
    } else {
      this.ui.appendEventLine(
        `? approval requested: ${event.name} ${formatArgs(event.args)}`
      );
    }

    let decision: ApprovalDecision;
    try {
      decision = await this.ui.requestApproval(effectivePrompt);
    } catch (error) {
      this.ui.showError(toErrorMessage(error));
      return;
    }

    // The turn may have ended (timeout/cancel) while the user was deciding.
    // The runtime has already cancelled the approval in that case.
    if (this.activeTurnId !== event.turnId) return;

    const structured = this.ui.approvalRequested !== undefined;
    try {
      await this.runtime.resolveApproval(event.turnId, event.callId, decision);
      if (!structured) {
        this.ui.appendEventLine(`approval ${decision}: ${event.name}`);
      }
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'APPROVAL_NOT_PENDING') {
        if (!structured) {
          this.ui.appendEventLine('approval expired: turn already ended');
        }
        return;
      }
      this.ui.showError(toErrorMessage(error));
    }
  }
}

export function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max)}…`;
}

export function formatArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args);
    return truncate(json ?? String(args), 120);
  } catch {
    return truncate(String(args), 120);
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof RuntimeError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
