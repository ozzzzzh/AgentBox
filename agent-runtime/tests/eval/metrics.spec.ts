import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../src/eval/metrics.js';
import type { TaskResult } from '../../src/eval/types.js';

function task(overrides: Partial<TaskResult>): TaskResult {
  return {
    id: 't',
    name: 'task',
    ok: true,
    turnOk: true,
    reason: 'end_turn',
    steps: 1,
    toolErrors: 0,
    approvals: 0,
    durationMs: 100,
    firstTokenMs: 50,
    check: { ok: true, type: 'file-exists', detail: 'ok' },
    workDir: '.',
    jsonl: 'events.jsonl',
    ...overrides,
  };
}

describe('eval metrics', () => {
  it('computes success, averages and totals', () => {
    const metrics = computeMetrics([
      task({ ok: true, steps: 2, durationMs: 200, firstTokenMs: 100, approvals: 1 }),
      task({
        ok: false,
        turnOk: false,
        reason: 'error',
        steps: 4,
        toolErrors: 2,
        durationMs: 400,
        firstTokenMs: null,
      }),
    ]);

    expect(metrics.total).toBe(2);
    expect(metrics.passed).toBe(1);
    expect(metrics.successRate).toBe(0.5);
    expect(metrics.avgSteps).toBe(3);
    expect(metrics.avgDurationMs).toBe(300);
    expect(metrics.avgFirstTokenMs).toBe(100);
    expect(metrics.totalApprovals).toBe(1);
    expect(metrics.totalToolErrors).toBe(2);
    expect(metrics.taskErrors).toBe(1);
  });

  it('handles empty results', () => {
    const metrics = computeMetrics([]);
    expect(metrics).toMatchObject({
      total: 0,
      passed: 0,
      successRate: 0,
      avgSteps: 0,
      avgDurationMs: 0,
      avgFirstTokenMs: null,
    });
  });
});
