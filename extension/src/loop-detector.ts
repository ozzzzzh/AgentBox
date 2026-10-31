export interface LoopDetectorOptions {
  /** Same tool signature failing this many times stops the turn. Default 2. */
  maxRepeatedFailures?: number;
  /** Consecutive failed tool calls stop the turn. Default 4. */
  maxConsecutiveFailures?: number;
}

export interface LoopDetectorResult {
  loop: boolean;
  reason?: string;
}

function stableArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

/**
 * Detects tool retry loops. A tool call is identified by name + args, and only
 * failures count: repeated successful calls (e.g. running tests after edits)
 * are legitimate. A success clears the failure count for that signature and
 * the consecutive-failure streak.
 */
export class ToolLoopDetector {
  private readonly signatures = new Map<string, string>();
  private readonly failures = new Map<string, number>();
  private consecutiveFailures = 0;
  private readonly maxRepeatedFailures: number;
  private readonly maxConsecutiveFailures: number;

  constructor(options: LoopDetectorOptions = {}) {
    this.maxRepeatedFailures = Math.max(
      2,
      options.maxRepeatedFailures ?? 2
    );
    this.maxConsecutiveFailures = Math.max(
      2,
      options.maxConsecutiveFailures ?? 4
    );
  }

  reset(): void {
    this.signatures.clear();
    this.failures.clear();
    this.consecutiveFailures = 0;
  }

  toolStart(callId: string, name: string, args: unknown): void {
    this.signatures.set(callId, `${name}:${stableArgs(args)}`);
  }

  toolEnd(callId: string, ok: boolean): LoopDetectorResult {
    const signature = this.signatures.get(callId) ?? `unknown:${callId}`;
    this.signatures.delete(callId);

    if (ok) {
      this.failures.delete(signature);
      this.consecutiveFailures = 0;
      return { loop: false };
    }

    this.consecutiveFailures += 1;
    const repeated = (this.failures.get(signature) ?? 0) + 1;
    this.failures.set(signature, repeated);

    if (repeated >= this.maxRepeatedFailures) {
      return {
        loop: true,
        reason: `相同工具调用连续失败 ${repeated} 次`,
      };
    }
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      return {
        loop: true,
        reason: `连续 ${this.consecutiveFailures} 次工具失败`,
      };
    }
    return { loop: false };
  }
}
