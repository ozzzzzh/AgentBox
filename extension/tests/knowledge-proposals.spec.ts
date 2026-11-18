import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalProposal,
  listLocalProposalSummaries,
  listLocalProposals,
  localProposalContentPath,
  markLocalProposalPublished,
  readLocalProposal,
  setLocalProposalStatus,
  updateLocalProposal,
} from '../src/knowledge/proposals';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-proposals-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function create(root: string) {
  return createLocalProposal(root, {
    title: '增量同步排查',
    summary: 'watermark 校验失败时的处理',
    content: '# 增量同步\n\n先校验 watermark。',
    tags: ['etl'],
    author: 'tester',
    provenance: { sessionId: 's1', turnId: 't1', workspace: 'D:/ws' },
  });
}

describe('local knowledge proposals', () => {
  it('creates pending proposals with metadata and markdown content', () => {
    const root = tempDir();
    const proposal = create(root);
    expect(proposal.status).toBe('pending');
    expect(proposal.source).toBe('conversation');
    expect(proposal.target).toBe('local');
    expect(proposal.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(localProposalContentPath(root, proposal.id))).toBe(true);
    const metadata = JSON.parse(
      readFileSync(
        join(
          root,
          'agentbox',
          'knowledge',
          'proposals',
          `${proposal.id}.json`
        ),
        'utf8'
      )
    ) as Record<string, unknown>;
    expect(metadata.title).toBe('增量同步排查');
    expect(metadata).not.toHaveProperty('content');
    expect(listLocalProposals(root)).toHaveLength(1);
  });

  it('reads edited markdown when approving', () => {
    const root = tempDir();
    const proposal = create(root);
    const contentPath = localProposalContentPath(root, proposal.id);
    writeFileSync(contentPath, '# Updated\n\nnew content\n', 'utf8');
    const updated = readLocalProposal(root, proposal.id);
    expect(updated?.content).toContain('new content');
    const approved = setLocalProposalStatus(root, proposal.id, 'approved', 'tester');
    expect(approved?.status).toBe('approved');
    expect(approved?.reviewer).toBe('tester');
    expect(approved?.content).toContain('new content');
  });

  it('updates, rejects and marks published', () => {
    const root = tempDir();
    const proposal = create(root);
    const updated = updateLocalProposal(root, proposal.id, {
      title: '新标题',
      content: '# 新正文',
      tags: ['sql', 'etl'],
    });
    expect(updated?.title).toBe('新标题');
    expect(updated?.content).toBe('# 新正文');

    const rejected = setLocalProposalStatus(root, proposal.id, 'rejected');
    expect(rejected?.status).toBe('rejected');

    const published = markLocalProposalPublished(root, proposal.id, 'd_123');
    expect(published?.status).toBe('published');
    expect(published?.publishedDocId).toBe('d_123');
    expect(listLocalProposalSummaries(root)[0]?.status).toBe('published');
  });
});
