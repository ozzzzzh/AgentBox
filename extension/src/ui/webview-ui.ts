import type {
  ApprovalDecision,
  StopReason,
  TokenUsageSnapshot,
} from '@agentbox/runtime';
import type { ApprovalPrompt, TurnUi } from '../controller';
import type { SessionEvent } from '../chat-protocol';

type Poster = (message: SessionEvent) => void;

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: unknown) => void;
}

/** TurnUi implementation that renders cards in the sidebar webview. */
export class WebviewTurnUi implements TurnUi {
  private readonly pending = new Map<string, PendingApproval>();
  private nextApproval = 1;
  private disposed = false;

  constructor(private readonly post: Poster) {}

  appendText(text: string): void {
    this.send({ type: 'assistant.delta', text });
  }

  appendEventLine(line: string): void {
    this.send({ type: 'log', text: line });
  }

  requestApproval(prompt: ApprovalPrompt): Promise<ApprovalDecision> {
    if (this.disposed) return Promise.resolve('deny');
    const id = `approval-${this.nextApproval++}`;
    return new Promise<ApprovalDecision>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({
        type: 'approval.request',
        id,
        turnId: prompt.turnId,
        callId: prompt.callId,
        name: prompt.name,
        args: prompt.args,
        ...(prompt.warning !== undefined ? { warning: prompt.warning } : {}),
      });
    });
  }

  resolveApproval(id: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    this.send({ type: 'approval.resolved', id, decision });
    pending.resolve(decision);
  }

  setBusy(busy: boolean): void {
    this.send({ type: 'busy', busy });
  }

  showError(message: string): void {
    this.send({ type: 'error', message });
  }

  turnStarted(turnId: string): void {
    this.send({ type: 'turn.start', turnId });
  }

  toolStarted(callId: string, name: string, args: unknown): void {
    this.send({ type: 'tool.start', callId, name, args });
  }

  toolEnded(
    callId: string,
    name: string,
    ok: boolean,
    result: string
  ): void {
    this.send({ type: 'tool.end', callId, name, ok, result });
  }

  fileChanged(path: string): void {
    this.send({ type: 'file.changed', path });
  }

  errorEvent(code: string, message: string): void {
    this.send({ type: 'error', code, message });
  }

  turnEnded(reason: StopReason): void {
    // An approval that is still waiting when the turn ends can no longer be
    // resolved by the runtime, so release it and mark the card as expired.
    this.cancelPendingApprovals();
    this.send({ type: 'turn.end', reason });
  }

  tokenUsage(usage: TokenUsageSnapshot): void {
    this.send({
      type: 'token.usage',
      turn: usage.last.totalTokens,
      session: usage.total.totalTokens,
    });
  }

  approvalRequested(): void {
    // requestApproval() renders the card; no extra log line.
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) {
      pending.resolve('deny');
    }
    this.pending.clear();
  }

  private cancelPendingApprovals(): void {
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id);
      if (pending === undefined) continue;
      this.pending.delete(id);
      this.send({ type: 'approval.cancelled', id });
      pending.resolve('deny');
    }
  }

  private send(message: SessionEvent): void {
    if (this.disposed) return;
    try {
      this.post(message);
    } catch {
      // The webview may be disposed between events.
    }
  }
}
