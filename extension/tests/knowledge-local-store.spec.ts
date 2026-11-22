import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listLocalKnowledge,
  localKnowledgeStatus,
  searchLocalKnowledge,
  upsertLocalKnowledge,
} from '../src/knowledge/local-store';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-local-kb-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('local knowledge store', () => {
  it('stores and searches captured knowledge without a server', () => {
    const root = tempDir();
    upsertLocalKnowledge(root, {
      id: 'kp_1',
      title: '增量同步排查',
      path: 'knowledge/kp_1.md',
      content: '# 增量同步\n\n先校验 watermark，再批量写入 orders。',
      tags: ['etl'],
      source: 'conversation',
    });
    const response = searchLocalKnowledge(root, {
      query: 'watermark',
      topK: 5,
    });
    expect(response.mode).toBe('instr');
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      docId: 'kp_1',
      path: 'knowledge/kp_1.md',
      heading: '增量同步',
      startLine: 1,
      endLine: 3,
    });
    expect(response.results[0]?.snippet).toContain('watermark');
    expect(listLocalKnowledge(root)).toHaveLength(1);
    expect(localKnowledgeStatus(root)).toMatchObject({
      documents: 1,
      chunks: 1,
    });
  });

  it('supports Chinese substring search and updates by stable id', () => {
    const root = tempDir();
    upsertLocalKnowledge(root, {
      id: 'kp_2',
      title: '订单表',
      path: 'knowledge/kp_2.md',
      content: '# 订单\n\n订单增量同步需要校验 watermark。',
    });
    upsertLocalKnowledge(root, {
      id: 'kp_2',
      title: '订单表',
      path: 'knowledge/kp_2.md',
      content: '# 订单\n\n订单增量同步需要校验 watermark 和 batch。',
    });
    const response = searchLocalKnowledge(root, { query: '增量同步' });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.text).toContain('batch');
    expect(listLocalKnowledge(root)).toHaveLength(1);
  });

  it('never returns secret local documents', () => {
    const root = tempDir();
    upsertLocalKnowledge(root, {
      id: 'kp_secret',
      title: 'secret',
      path: 'knowledge/kp_secret.md',
      content: '# secret\n\nsecret_marker',
      sensitivity: 'secret',
    });
    expect(
      searchLocalKnowledge(root, { query: 'secret_marker' }).results
    ).toHaveLength(0);
  });
});
