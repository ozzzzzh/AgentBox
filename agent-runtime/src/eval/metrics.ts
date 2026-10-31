import type { EvalMetrics, TaskResult } from './types.js';

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeMetrics(tasks: TaskResult[]): EvalMetrics {
  const total = tasks.length;
  const passed = tasks.filter((task) => task.ok).length;
  const firstTokens = tasks
    .map((task) => task.firstTokenMs)
    .filter((value): value is number => value !== null);

  return {
    total,
    passed,
    successRate: total === 0 ? 0 : passed / total,
    avgSteps: average(tasks.map((task) => task.steps)),
    avgDurationMs: average(tasks.map((task) => task.durationMs)),
    avgFirstTokenMs:
      firstTokens.length === 0 ? null : average(firstTokens),
    totalApprovals: tasks.reduce((sum, task) => sum + task.approvals, 0),
    totalToolErrors: tasks.reduce((sum, task) => sum + task.toolErrors, 0),
    taskErrors: tasks.filter(
      (task) => task.reason === 'error' || task.reason === 'not_started'
    ).length,
  };
}
