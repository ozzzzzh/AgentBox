import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonlWriter, readJsonl, readJsonlFile } from '../../src/cli/jsonl.js';
import type { AgentEvent } from '../../src/types.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-jsonl-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('JSONL', () => {
  it('writes events and summary records as one JSON object per line', async () => {
    const path = join(dir, 'events.jsonl');
    const writer = new JsonlWriter(path);
    const event: AgentEvent = {
      type: 'turn.start',
      turnId: 't1',
      runtime: 'codex',
      at: 1,
    };
    writer.writeEvent(event, { taskId: 'task-1' });
    writer.writeRecord({ type: 'summary', ok: true });
    await writer.close();
    await writer.close();

    const records = readJsonlFile(path);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: 'turn.start',
      turnId: 't1',
      taskId: 'task-1',
    });
    expect(records[1]).toEqual({ type: 'summary', ok: true });
    expect(readFileSync(path, 'utf8')).toBe(
      `${JSON.stringify(records[0])}\n${JSON.stringify(records[1])}\n`
    );
  });

  it('reports malformed lines with line numbers', () => {
    expect(() => readJsonl('{"ok":true}\nnot-json\n')).toThrow(/line 2/);
    expect(() => readJsonl('[1,2]\n')).toThrow(/line 1/);
  });

  it('skips blank lines', () => {
    expect(readJsonl('\n{"a":1}\n\n')).toEqual([{ a: 1 }]);
  });
});
