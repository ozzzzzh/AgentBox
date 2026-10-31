import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWithRuntime } from '../../src/cli/index.js';
import { JsonlWriter, readJsonlFile } from '../../src/cli/jsonl.js';
import { FakeRuntime } from '../../src/testing/fake-runtime.js';

let workspace: string;
let dir: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentbox-cli-ws-'));
  dir = mkdtempSync(join(tmpdir(), 'agentbox-cli-out-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('CLI run core', () => {
  it('writes events and a summary for a successful turn', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [
        { type: 'text', text: 'hello' },
        {
          type: 'tool',
          callId: 'c1',
          name: 'read_file',
          args: { path: 'a.txt' },
          ok: true,
          result: 'ok',
        },
        { type: 'file', path: 'a.txt' },
      ],
    });
    const path = join(dir, 'events.jsonl');
    const writer = new JsonlWriter(path);

    const result = await runWithRuntime(
      runtime,
      {
        prompt: 'test',
        workspaceRoot: workspace,
        taskId: 'task-1',
        approval: 'deny',
      },
      writer
    );
    await writer.close();

    expect(result).toMatchObject({
      ok: true,
      reason: 'end_turn',
      steps: 1,
    });
    const records = readJsonlFile(path);
    expect(records[0]).toMatchObject({
      type: 'turn.start',
      taskId: 'task-1',
    });
    expect(records.some((record) => record.type === 'tool.start')).toBe(true);
    expect(records[records.length - 1]).toMatchObject({
      type: 'summary',
      taskId: 'task-1',
      ok: true,
      reason: 'end_turn',
      steps: 1,
    });
  });

  it('returns deny for approvals and keeps the turn result', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [
        {
          type: 'approval',
          callId: 'c1',
          name: 'shell',
          args: { command: 'rm -rf /' },
          denyResult: 'denied by policy',
        },
      ],
    });
    const path = join(dir, 'approval.jsonl');
    const writer = new JsonlWriter(path);

    const result = await runWithRuntime(
      runtime,
      {
        prompt: 'approval',
        workspaceRoot: workspace,
        approval: 'deny',
      },
      writer
    );
    await writer.close();

    expect(result.ok).toBe(true);
    const records = readJsonlFile(path);
    expect(records.some((record) => record.type === 'approval.request')).toBe(true);
    expect(
      records.some(
        (record) =>
          record.type === 'tool.end' &&
          record.callId === 'c1' &&
          record.ok === false
      )
    ).toBe(true);
  });

  it('aborts through AbortSignal and reports cancelled', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [{ type: 'delay', ms: 10_000 }],
    });
    const writer = new JsonlWriter(join(dir, 'cancel.jsonl'));
    const controller = new AbortController();

    const run = runWithRuntime(
      runtime,
      {
        prompt: 'long',
        workspaceRoot: workspace,
        approval: 'deny',
        signal: controller.signal,
      },
      writer
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await run;
    await writer.close();

    expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
  });

  it('writes an error summary when the turn cannot start', async () => {
    const runtime = new FakeRuntime();
    const writer = new JsonlWriter(join(dir, 'error.jsonl'));

    const result = await runWithRuntime(
      runtime,
      {
        prompt: 'invalid',
        workspaceRoot: join(workspace, 'missing'),
        approval: 'deny',
      },
      writer
    );
    await writer.close();

    expect(result).toMatchObject({ ok: false, reason: 'error' });
    const records = readJsonlFile(join(dir, 'error.jsonl'));
    expect(records.some((record) => record.type === 'error')).toBe(true);
    expect(records[records.length - 1]).toMatchObject({
      type: 'summary',
      ok: false,
      reason: 'error',
    });
  });
});
