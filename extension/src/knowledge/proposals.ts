import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  KnowledgeProposal,
  KnowledgeProposalInput,
  KnowledgeProposalPatch,
  KnowledgeProposalStatus,
  KnowledgeProposalSummary,
  Sensitivity,
} from './types';

interface ProposalMetadata {
  id: string;
  kind: 'knowledge';
  status: KnowledgeProposalStatus;
  title: string;
  summary: string;
  tags: string[];
  sensitivity: Sensitivity;
  source: 'conversation';
  target: 'local' | 'remote';
  provenance: KnowledgeProposal['provenance'];
  author: string;
  reviewer?: string;
  contentHash: string;
  createdAt: string;
  reviewedAt?: string;
  publishedDocId?: string;
}

const PROPOSAL_ID = /^[A-Za-z0-9_-]{1,128}$/;

function proposalDir(globalStorage: string): string {
  return join(globalStorage, 'agentbox', 'knowledge', 'proposals');
}

export function localProposalContentPath(
  globalStorage: string,
  id: string
): string {
  if (!PROPOSAL_ID.test(id)) throw new Error('invalid proposal id');
  return join(proposalDir(globalStorage), `${id}.md`);
}

function metadataPath(globalStorage: string, id: string): string {
  if (!PROPOSAL_ID.test(id)) throw new Error('invalid proposal id');
  return join(proposalDir(globalStorage), `${id}.json`);
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(proposalDirFromPath(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content, 'utf8');
  try {
    renameSync(temp, path);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    // Windows can transiently lock the destination (indexer/AV). Fall back to
    // an in-place write rather than losing the proposal update.
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST') {
      writeFileSync(path, content, 'utf8');
      try {
        rmSync(temp, { force: true });
      } catch {
        // Best effort cleanup.
      }
      return;
    }
    throw error;
  }
}

function proposalDirFromPath(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index < 0 ? '.' : path.slice(0, index);
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function readMetadata(
  globalStorage: string,
  id: string
): ProposalMetadata | undefined {
  const path = metadataPath(globalStorage, id);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ProposalMetadata;
    if (
      value.id !== id ||
      value.kind !== 'knowledge' ||
      typeof value.title !== 'string' ||
      typeof value.contentHash !== 'string'
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function readContent(globalStorage: string, id: string): string {
  const path = localProposalContentPath(globalStorage, id);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function toProposal(
  globalStorage: string,
  metadata: ProposalMetadata
): KnowledgeProposal {
  return {
    ...metadata,
    content: readContent(globalStorage, metadata.id),
  };
}

function writeProposal(
  globalStorage: string,
  metadata: ProposalMetadata,
  content: string
): KnowledgeProposal {
  mkdirSync(proposalDir(globalStorage), { recursive: true });
  const withHash: ProposalMetadata = {
    ...metadata,
    contentHash: hash(content),
  };
  atomicWrite(
    localProposalContentPath(globalStorage, metadata.id),
    content.endsWith('\n') ? content : `${content}\n`
  );
  atomicWrite(
    metadataPath(globalStorage, metadata.id),
    `${JSON.stringify(withHash, null, 2)}\n`
  );
  return { ...withHash, content };
}

export function createLocalProposal(
  globalStorage: string,
  input: KnowledgeProposalInput
): KnowledgeProposal {
  const title = input.title.trim();
  const content = input.content.trim();
  if (title === '' || content === '') {
    throw new Error('proposal title and content are required');
  }
  const id = `kp_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const createdAt = new Date().toISOString();
  const metadata: ProposalMetadata = {
    id,
    kind: 'knowledge',
    status: 'pending',
    title,
    summary: input.summary.trim(),
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    sensitivity: input.sensitivity ?? 'internal',
    source: 'conversation',
    target: input.target ?? 'local',
    provenance: input.provenance ?? {},
    author: input.author,
    contentHash: '',
    createdAt,
  };
  return writeProposal(globalStorage, metadata, content);
}

export function readLocalProposal(
  globalStorage: string,
  id: string
): KnowledgeProposal | undefined {
  const metadata = readMetadata(globalStorage, id);
  return metadata === undefined ? undefined : toProposal(globalStorage, metadata);
}

export function listLocalProposals(
  globalStorage: string,
  status?: KnowledgeProposalStatus
): KnowledgeProposal[] {
  const dir = proposalDir(globalStorage);
  if (!existsSync(dir)) return [];
  const result: KnowledgeProposal[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const proposal = readLocalProposal(globalStorage, id);
    if (proposal === undefined) continue;
    if (status !== undefined && proposal.status !== status) continue;
    result.push(proposal);
  }
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return result;
}

export function listLocalProposalSummaries(
  globalStorage: string,
  status?: KnowledgeProposalStatus
): KnowledgeProposalSummary[] {
  return listLocalProposals(globalStorage, status).map((proposal) => ({
    id: proposal.id,
    status: proposal.status,
    title: proposal.title,
    summary: proposal.summary,
    tags: proposal.tags,
    createdAt: proposal.createdAt,
    ...(proposal.reviewedAt !== undefined
      ? { reviewedAt: proposal.reviewedAt }
      : {}),
  }));
}

export function updateLocalProposal(
  globalStorage: string,
  id: string,
  patch: KnowledgeProposalPatch
): KnowledgeProposal | undefined {
  const metadata = readMetadata(globalStorage, id);
  if (metadata === undefined) return undefined;
  const content =
    patch.content !== undefined ? patch.content : readContent(globalStorage, id);
  const updated: ProposalMetadata = {
    ...metadata,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
    ...(patch.tags !== undefined
      ? { tags: patch.tags.map((tag) => tag.trim()).filter(Boolean) }
      : {}),
    ...(patch.sensitivity !== undefined
      ? { sensitivity: patch.sensitivity }
      : {}),
  };
  return writeProposal(globalStorage, updated, content);
}

export function setLocalProposalStatus(
  globalStorage: string,
  id: string,
  status: KnowledgeProposalStatus,
  reviewer?: string
): KnowledgeProposal | undefined {
  const metadata = readMetadata(globalStorage, id);
  if (metadata === undefined) return undefined;
  const content = readContent(globalStorage, id);
  const updated: ProposalMetadata = {
    ...metadata,
    status,
    ...(reviewer !== undefined ? { reviewer } : {}),
    ...(status === 'approved' || status === 'rejected'
      ? { reviewedAt: new Date().toISOString() }
      : {}),
  };
  return writeProposal(globalStorage, updated, content);
}

export function markLocalProposalPublished(
  globalStorage: string,
  id: string,
  docId: string
): KnowledgeProposal | undefined {
  const metadata = readMetadata(globalStorage, id);
  if (metadata === undefined) return undefined;
  const content = readContent(globalStorage, id);
  const updated: ProposalMetadata = {
    ...metadata,
    status: 'published',
    publishedDocId: docId,
    reviewedAt: metadata.reviewedAt ?? new Date().toISOString(),
  };
  return writeProposal(globalStorage, updated, content);
}
