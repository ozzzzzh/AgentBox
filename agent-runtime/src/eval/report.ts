import type { EvalReport } from './types.js';

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ms(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}ms`;
}

export function renderMarkdown(report: EvalReport): string {
  const { metrics } = report;
  const lines: string[] = [
    `# AgentBox eval: ${report.runtime}${report.model ? ` / ${report.model}` : ''}`,
    '',
    `- started: ${report.startedAt}`,
    `- finished: ${report.finishedAt}`,
    `- tasks: ${report.taskFile}`,
    '',
    '## Metrics',
    '',
    '| metric | value |',
    '|---|---|',
    `| success | ${metrics.passed}/${metrics.total} (${percent(metrics.successRate)}) |`,
    `| avg steps | ${metrics.avgSteps.toFixed(1)} |`,
    `| avg duration | ${ms(metrics.avgDurationMs)} |`,
    `| avg first token | ${ms(metrics.avgFirstTokenMs)} |`,
    `| approvals | ${metrics.totalApprovals} |`,
    `| tool errors | ${metrics.totalToolErrors} |`,
    `| task errors | ${metrics.taskErrors} |`,
    '',
    '## Tasks',
    '',
    '| # | task | ok | turn | reason | steps | tools err | approvals | duration | check |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];

  report.tasks.forEach((task, index) => {
    lines.push(
      `| ${index + 1} | ${task.name} | ${task.ok ? '✅' : '❌'} | ${
        task.turnOk ? 'ok' : 'fail'
      } | ${task.reason} | ${task.steps} | ${task.toolErrors} | ${
        task.approvals
      } | ${ms(task.durationMs)} | ${task.check.ok ? 'ok' : 'fail'} - ${task.check.detail.replace(/\|/g, '\\|')} |`
    );
  });

  lines.push(
    '',
    '## Failures',
    '',
  );
  const failures = report.tasks.filter((task) => !task.ok);
  if (failures.length === 0) {
    lines.push('None.');
  } else {
    for (const task of failures) {
      lines.push(
        `### ${task.name} (${task.id})`,
        '',
        `- reason: ${task.reason}`,
        `- check: ${task.check.detail}`,
        `- workDir: ${task.workDir}`,
        `- jsonl: ${task.jsonl}`,
        ''
      );
    }
  }

  return `${lines.join('\n')}\n`;
}
