import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEval } from '../../src/eval/runner.js';
import { FakeRuntime } from '../../src/testing/fake-runtime.js';

let dir: string;
let taskFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-eval-runner-'));
  taskFile = join(dir, 'tasks.json');
  writeFileSync(
    taskFile,
    JSON.stringify([
      {
        id: 'pass',
        name: 'passes text check',
        prompt: 'say asset',
        files: { 'README.md': 'fixture' },
        check: { type: 'text-contains-all', values: ['asset'] },
      },
      {
        id: 'fail',
        name: 'fails text check',
        prompt: 'say something else',
        check: { type: 'text-contains-all', values: ['missing'] },
      },
    ])
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function createFakeRuntime(): FakeRuntime {
  return new FakeRuntime({
    defaultScript: [{ type: 'text', text: 'asset' }],
  });
}

describe('eval runner', () => {
  it('runs tasks, writes JSONL and a report', async () => {
    const outDir = join(dir, 'out');
    const report = await runEval({
      taskFile,
      outDir,
      runtime: 'codex',
      model: 'mock-model',
      approval: 'deny',
      limits: { maxSteps: 10, turnTimeoutMs: 5_000 },
      createRuntime: () => createFakeRuntime(),
    });

    expect(report.metrics.total).toBe(2);
    expect(report.metrics.passed).toBe(1);
    expect(report.metrics.successRate).toBe(0.5);
    expect(report.tasks[0]).toMatchObject({ id: 'pass', ok: true });
    expect(report.tasks[1]).toMatchObject({ id: 'fail', ok: false });

    expect(existsSync(join(outDir, 'pass.jsonl'))).toBe(true);
    expect(existsSync(join(outDir, 'fail.jsonl'))).toBe(true);
    expect(existsSync(join(outDir, 'report.json'))).toBe(true);
    expect(existsSync(join(outDir, 'report.md'))).toBe(true);

    const jsonl = readFileSync(join(outDir, 'pass.jsonl'), 'utf8');
    expect(jsonl).toContain('"type":"turn.start"');
    expect(jsonl).toContain('"type":"summary"');
    expect(readFileSync(join(outDir, 'report.md'), 'utf8')).toContain(
      '1/2'
    );
  });

  it('supports task filtering', async () => {
    const outDir = join(dir, 'filtered');
    const report = await runEval({
      taskFile,
      outDir,
      runtime: 'codex',
      approval: 'deny',
      only: ['pass'],
      createRuntime: () => createFakeRuntime(),
    });

    expect(report.metrics.total).toBe(1);
    expect(report.tasks[0].id).toBe('pass');
    expect(existsSync(join(outDir, 'fail.jsonl'))).toBe(false);
  });

  it('reports invalid task files', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify([{ id: 'x' }]));
    await expect(
      runEval({
        taskFile: bad,
        outDir: join(dir, 'bad-out'),
        runtime: 'codex',
        approval: 'deny',
        createRuntime: () => createFakeRuntime(),
      })
    ).rejects.toThrow(/name/);
  });
});
