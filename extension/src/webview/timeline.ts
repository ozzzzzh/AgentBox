export type TimelineKind = 'thinking' | 'generation' | 'tool';

export interface TimelineSpan {
  kind: TimelineKind;
  start: number;
  end: number;
  label: string;
  ok?: boolean;
  callId?: string;
  summary?: string;
}

interface MutableSpan extends Omit<TimelineSpan, 'end'> {
  end: number | null;
}

type LlmPhase = 'thinking' | 'generation';

/**
 * Per-turn activity timeline.
 *
 * The LLM phase starts as "thinking" and flips to "generation" on the first
 * text delta after turn start / tool end. Tool runs are explicit spans. This
 * gives three lanes: 思考 / 生成 / 工具.
 */
export class TurnTimeline {
  private startAt = 0;
  private endAt: number | null = null;
  private phase: LlmPhase = 'thinking';
  private phaseStart: number | null = null;
  private spans: MutableSpan[] = [];

  get started(): boolean {
    return this.startAt > 0;
  }

  get running(): boolean {
    return this.started && this.endAt === null;
  }

  get start(): number {
    return this.startAt;
  }

  get end(): number | null {
    return this.endAt;
  }

  begin(at: number): void {
    this.startAt = at;
    this.endAt = null;
    this.phase = 'thinking';
    this.phaseStart = at;
    this.spans = [];
  }

  reset(): void {
    this.startAt = 0;
    this.endAt = null;
    this.phase = 'thinking';
    this.phaseStart = null;
    this.spans = [];
  }

  /** Called on text deltas; returns true when thinking flips to generation. */
  textDelta(at: number): boolean {
    this.ensureStarted(at);
    if (this.phase === 'generation' && this.phaseStart !== null) {
      return false;
    }
    this.closePhase(at);
    this.phase = 'generation';
    this.phaseStart = at;
    return true;
  }

  /** Approval waiting is folded into the thinking lane. */
  approvalWait(at: number): void {
    this.ensureStarted(at);
    this.closePhase(at);
    this.phase = 'thinking';
    this.phaseStart = at;
  }

  toolStart(
    at: number,
    callId: string,
    name: string,
    summary?: string
  ): void {
    this.ensureStarted(at);
    this.closePhase(at);
    this.phaseStart = null;
    this.spans.push({
      kind: 'tool',
      start: at,
      end: null,
      label: name,
      ok: true,
      callId,
      ...(summary !== undefined ? { summary } : {}),
    });
  }

  toolEnd(at: number, callId: string, ok: boolean): void {
    this.ensureStarted(at);
    const span = this.findToolSpan(callId);
    if (span !== undefined) {
      span.end = at;
      span.ok = ok;
    }
    this.phase = 'thinking';
    this.phaseStart = at;
  }

  finish(at: number): void {
    if (!this.started) return;
    this.closePhase(at);
    for (const span of this.spans) {
      if (span.end === null) span.end = at;
    }
    this.endAt = at;
    this.phaseStart = null;
  }

  /** Completed + currently open spans, with open ends extended to `now`. */
  snapshot(now: number): TimelineSpan[] {
    if (!this.started) return [];
    const end = this.endAt ?? now;
    const result: TimelineSpan[] = this.spans.map((span) => ({
      ...span,
      end: span.end ?? end,
    }));
    if (this.phaseStart !== null && end > this.phaseStart) {
      result.push({
        kind: this.phase,
        start: this.phaseStart,
        end,
        label: this.phase === 'thinking' ? '思考' : '生成',
      });
    }
    return result;
  }

  duration(now: number): number {
    if (!this.started) return 0;
    return Math.max((this.endAt ?? now) - this.startAt, 0);
  }

  private ensureStarted(at: number): void {
    if (!this.started) this.begin(at);
  }

  private closePhase(at: number): void {
    if (this.phaseStart === null) return;
    if (at > this.phaseStart) {
      this.spans.push({
        kind: this.phase,
        start: this.phaseStart,
        end: at,
        label: this.phase === 'thinking' ? '思考' : '生成',
      });
    }
    this.phaseStart = null;
  }

  private findToolSpan(callId: string): MutableSpan | undefined {
    for (let index = this.spans.length - 1; index >= 0; index -= 1) {
      const span = this.spans[index];
      if (span !== undefined && span.kind === 'tool' && span.callId === callId) {
        return span;
      }
    }
    return undefined;
  }
}
