import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  parseSkillPackage,
  type SkillManifest,
  type SkillPackage,
} from './model';

export type SkillStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface VersionRecord {
  id: string;
  version: string;
  hash: string;
  status: SkillStatus;
  manifest: SkillManifest;
  submittedBy: string;
  submittedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  comment?: string;
}

export interface SkillIndex {
  skills: Record<
    string,
    {
      versions: Record<string, VersionRecord>;
    }
  >;
}

export interface PolicyRecord {
  required: boolean;
  /** Whether this version is delivered to agents at all. */
  enabled: boolean;
  version: string;
  target: string;
  updatedBy: string;
  updatedAt: string;
}

export interface PolicyIndex {
  policies: Record<string, PolicyRecord>;
}

export interface SkillGroup {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GroupIndex {
  groups: Record<string, SkillGroup>;
}

export type MembershipStatus = 'pending' | 'approved' | 'rejected';

export interface GroupMembershipRecord {
  status: MembershipStatus;
  requestedAt: string;
  updatedAt: string;
  reviewedBy?: string;
}

export interface ClientMembership {
  clientId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  groups: Record<string, GroupMembershipRecord>;
}

export interface MembershipIndex {
  clients: Record<string, ClientMembership>;
}

export interface ClientGroupView extends SkillGroup {
  membership: MembershipStatus | 'none';
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  id?: string;
  version?: string;
  detail?: string;
}

export interface SkillSummary {
  id: string;
  version: string;
  status: SkillStatus;
  required: boolean;
  enabled: boolean;
  hash: string;
  name: string;
  description: string;
  owner: string;
  activation: string;
  priority: number;
  groups: string[];
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, path);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export class SkillStore {
  private index: SkillIndex;
  private policies: PolicyIndex;
  private groupIndex: GroupIndex;
  private membershipIndex: MembershipIndex;

  private readonly indexFile: string;
  private readonly policyFile: string;
  private readonly groupFile: string;
  private readonly membershipFile: string;
  private readonly auditFile: string;

  constructor(readonly dataDir: string) {
    this.indexFile = join(dataDir, 'index.json');
    this.policyFile = join(dataDir, 'policies.json');
    this.groupFile = join(dataDir, 'groups.json');
    this.membershipFile = join(dataDir, 'memberships.json');
    this.auditFile = join(dataDir, 'audit.jsonl');
    mkdirSync(dataDir, { recursive: true });
    this.index = readJson<SkillIndex>(this.indexFile, { skills: {} });
    this.policies = readJson<PolicyIndex>(this.policyFile, { policies: {} });
    this.groupIndex = readJson<GroupIndex>(this.groupFile, { groups: {} });
    this.membershipIndex = readJson<MembershipIndex>(this.membershipFile, {
      clients: {},
    });
  }

  private saveIndex(): void {
    atomicWrite(this.indexFile, `${JSON.stringify(this.index, null, 2)}\n`);
  }

  private savePolicies(): void {
    atomicWrite(
      this.policyFile,
      `${JSON.stringify(this.policies, null, 2)}\n`
    );
  }

  private saveGroups(): void {
    atomicWrite(this.groupFile, `${JSON.stringify(this.groupIndex, null, 2)}\n`);
  }

  private saveMemberships(): void {
    atomicWrite(
      this.membershipFile,
      `${JSON.stringify(this.membershipIndex, null, 2)}\n`
    );
  }

  private packagePath(id: string, version: string): string {
    return join(this.dataDir, 'packages', id, `${version}.json`);
  }

  private writePackage(skill: SkillPackage): void {
    atomicWrite(
      this.packagePath(skill.manifest.id, skill.manifest.version),
      `${JSON.stringify(skill, null, 2)}\n`
    );
  }

  readPackage(id: string, version: string): SkillPackage | undefined {
    const path = this.packagePath(id, version);
    if (!existsSync(path)) return undefined;
    try {
      return parseSkillPackage(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return undefined;
    }
  }

  getRecord(id: string, version: string): VersionRecord | undefined {
    return this.index.skills[id]?.versions[version];
  }

  list(includeUnapproved = false): SkillSummary[] {
    const result: SkillSummary[] = [];
    for (const [id, entry] of Object.entries(this.index.skills)) {
      for (const record of Object.values(entry.versions)) {
        if (!includeUnapproved && record.status !== 'approved') continue;
        result.push(this.summary(id, record));
      }
    }
    result.sort((a, b) =>
      `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`)
    );
    return result;
  }

  private summary(id: string, record: VersionRecord): SkillSummary {
    const policy = this.policies.policies[id];
    const policyApplies = policy?.version === record.version;
    const enabled = policyApplies ? policy.enabled !== false : true;
    return {
      id,
      version: record.version,
      status: record.status,
      required: enabled && policyApplies && policy.required === true,
      enabled,
      hash: record.hash,
      name: record.manifest.name,
      description: record.manifest.description,
      owner: record.manifest.owner,
      activation: record.manifest.activation,
      priority: record.manifest.priority,
      groups: this.groupsForSkill(id).map((group) => group.name),
    };
  }

  upload(skill: SkillPackage, actor: string): VersionRecord {
    const { id, version } = skill.manifest;
    const existing = this.getRecord(id, version);
    if (existing !== undefined) {
      throw new Error(`skill ${id}@${version} already exists`);
    }
    this.writePackage(skill);
    const record: VersionRecord = {
      id,
      version,
      hash: skill.hash,
      status: 'pending',
      manifest: skill.manifest,
      submittedBy: actor,
      submittedAt: new Date().toISOString(),
    };
    this.index.skills[id] ??= { versions: {} };
    this.index.skills[id]!.versions[version] = record;
    this.saveIndex();
    this.audit({ actor, action: 'upload', id, version });
    return record;
  }

  approve(
    id: string,
    version: string,
    actor: string,
    comment?: string
  ): VersionRecord {
    const record = this.requireRecord(id, version);
    if (record.status !== 'pending') {
      throw new Error(`skill ${id}@${version} is ${record.status}`);
    }
    record.status = 'approved';
    record.reviewedBy = actor;
    record.reviewedAt = new Date().toISOString();
    if (comment !== undefined) record.comment = comment;
    this.saveIndex();
    this.audit({ actor, action: 'approve', id, version, detail: comment });
    return record;
  }

  reject(
    id: string,
    version: string,
    actor: string,
    comment?: string
  ): VersionRecord {
    const record = this.requireRecord(id, version);
    if (record.status !== 'pending') {
      throw new Error(`skill ${id}@${version} is ${record.status}`);
    }
    record.status = 'rejected';
    record.reviewedBy = actor;
    record.reviewedAt = new Date().toISOString();
    if (comment !== undefined) record.comment = comment;
    this.saveIndex();
    this.audit({ actor, action: 'reject', id, version, detail: comment });
    return record;
  }

  revoke(id: string, version: string, actor: string): VersionRecord {
    const record = this.requireRecord(id, version);
    if (record.status !== 'approved') {
      throw new Error(`skill ${id}@${version} is ${record.status}`);
    }
    record.status = 'revoked';
    record.reviewedBy = actor;
    record.reviewedAt = new Date().toISOString();
    const policy = this.policies.policies[id];
    if (policy?.version === version) {
      delete this.policies.policies[id];
      this.savePolicies();
    }
    this.saveIndex();
    this.audit({ actor, action: 'revoke', id, version });
    return record;
  }

  setPolicy(
    id: string,
    policy: Omit<PolicyRecord, 'enabled' | 'updatedBy' | 'updatedAt'> & { enabled?: boolean },
    actor: string
  ): PolicyRecord {
    const record = this.requireRecord(id, policy.version);
    if (record.status !== 'approved') {
      throw new Error(`cannot require ${id}@${policy.version}: not approved`);
    }
    const existing = this.policies.policies[id];
    const enabled = policy.enabled ?? existing?.enabled ?? true;
    const next: PolicyRecord = {
      ...policy,
      required: enabled && policy.required === true,
      enabled,
      updatedBy: actor,
      updatedAt: new Date().toISOString(),
    };
    this.policies.policies[id] = next;
    this.savePolicies();
    this.audit({
      actor,
      action: 'policy',
      id,
      version: policy.version,
      detail: `required=${next.required} enabled=${next.enabled} target=${policy.target}`,
    });
    return next;
  }

  required(target?: string): SkillSummary[] {
    const result: SkillSummary[] = [];
    for (const [id, policy] of Object.entries(this.policies.policies)) {
      if (!policy.required || policy.enabled === false) continue;
      if (
        target !== undefined &&
        target !== '' &&
        policy.target !== 'all' &&
        policy.target !== target
      ) {
        continue;
      }
      const record = this.getRecord(id, policy.version);
      if (record?.status !== 'approved') continue;
      result.push(this.summary(id, record));
    }
    return result;
  }

  policyOf(id: string): PolicyRecord | undefined {
    return this.policies.policies[id];
  }

  listGroups(): SkillGroup[] {
    return Object.values(this.groupIndex.groups).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  groupsForSkill(skillId: string): SkillGroup[] {
    return this.listGroups().filter((group) => group.skillIds.includes(skillId));
  }

  upsertGroup(
    id: string,
    input: {
      name: string;
      description?: string;
      skillIds?: string[];
    },
    actor: string
  ): SkillGroup {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) {
      throw new Error('group id must match ^[a-z0-9][a-z0-9._-]{1,63}$');
    }
    const name = input.name.trim();
    if (name === '') throw new Error('group name is required');
    const skillIds = [...new Set(input.skillIds ?? [])]
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const now = new Date().toISOString();
    const existing = this.groupIndex.groups[id];
    const group: SkillGroup = {
      id,
      name,
      description: (input.description ?? '').trim(),
      skillIds,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.groupIndex.groups[id] = group;
    this.saveGroups();
    this.audit({
      actor,
      action: 'group',
      id,
      detail: `name=${name} skills=${skillIds.join(',')}`,
    });
    return group;
  }

  deleteGroup(id: string, actor: string): boolean {
    if (this.groupIndex.groups[id] === undefined) return false;
    delete this.groupIndex.groups[id];
    this.saveGroups();
    this.audit({ actor, action: 'group-delete', id });
    return true;
  }

  clientGroups(clientId: string | undefined): ClientGroupView[] {
    const client = clientId === undefined
      ? undefined
      : this.membershipIndex.clients[clientId];
    return this.listGroups().map((group) => ({
      ...group,
      membership: client?.groups[group.id]?.status ?? 'none',
    }));
  }

  requestGroup(
    clientId: string,
    clientName: string,
    groupId: string,
    actor: string
  ): GroupMembershipRecord {
    if (this.groupIndex.groups[groupId] === undefined) {
      throw new Error(`group ${groupId} not found`);
    }
    if (!/^[A-Za-z0-9._:-]{3,128}$/.test(clientId)) {
      throw new Error('invalid client id');
    }
    const now = new Date().toISOString();
    const existingClient = this.membershipIndex.clients[clientId];
    const client: ClientMembership = existingClient ?? {
      clientId,
      name: clientName.trim() || clientId,
      createdAt: now,
      updatedAt: now,
      groups: {},
    };
    if (clientName.trim() !== '') client.name = clientName.trim();
    const existing = client.groups[groupId];
    if (existing?.status === 'approved') return existing;
    const record: GroupMembershipRecord = {
      status: 'pending',
      requestedAt: existing?.requestedAt ?? now,
      updatedAt: now,
    };
    client.groups[groupId] = record;
    client.updatedAt = now;
    this.membershipIndex.clients[clientId] = client;
    this.saveMemberships();
    this.audit({
      actor,
      action: 'group-request',
      id: groupId,
      detail: `client=${clientId}`,
    });
    return record;
  }

  decideGroup(
    clientId: string,
    groupId: string,
    decision: 'approved' | 'rejected',
    actor: string
  ): GroupMembershipRecord {
    const client = this.membershipIndex.clients[clientId];
    if (client === undefined) throw new Error(`client ${clientId} not found`);
    if (this.groupIndex.groups[groupId] === undefined) {
      throw new Error(`group ${groupId} not found`);
    }
    const record = client.groups[groupId];
    if (record === undefined) throw new Error(`group request not found`);
    record.status = decision;
    record.updatedAt = new Date().toISOString();
    record.reviewedBy = actor;
    client.updatedAt = record.updatedAt;
    this.saveMemberships();
    this.audit({
      actor,
      action: `group-${decision === 'approved' ? 'approve' : 'reject'}`,
      id: groupId,
      detail: `client=${clientId}`,
    });
    return record;
  }

  listGroupRequests(status: MembershipStatus | 'all' = 'pending'): Array<{
    clientId: string;
    clientName: string;
    groupId: string;
    groupName: string;
    status: MembershipStatus;
    requestedAt: string;
    updatedAt: string;
  }> {
    const result = [];
    for (const client of Object.values(this.membershipIndex.clients)) {
      for (const [groupId, membership] of Object.entries(client.groups)) {
        if (status !== 'all' && membership.status !== status) continue;
        result.push({
          clientId: client.clientId,
          clientName: client.name,
          groupId,
          groupName: this.groupIndex.groups[groupId]?.name ?? groupId,
          status: membership.status,
          requestedAt: membership.requestedAt,
          updatedAt: membership.updatedAt,
        });
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  approvedGroupIds(clientId: string | undefined): Set<string> {
    const client = clientId === undefined
      ? undefined
      : this.membershipIndex.clients[clientId];
    if (client === undefined) return new Set();
    return new Set(
      Object.entries(client.groups)
        .filter(([, membership]) => membership.status === 'approved')
        .map(([groupId]) => groupId)
    );
  }

  skillAccessible(clientId: string | undefined, skillId: string): boolean {
    const groups = this.groupsForSkill(skillId);
    if (groups.length === 0) return true;
    const approved = this.approvedGroupIds(clientId);
    return groups.some((group) => approved.has(group.id));
  }

  audit(entry: Omit<AuditEntry, 'at'>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    appendFileSync(this.auditFile, `${line}\n`, 'utf8');
  }

  readAudit(limit = 200): AuditEntry[] {
    if (!existsSync(this.auditFile)) return [];
    const lines = readFileSync(this.auditFile, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    return lines
      .slice(-Math.max(1, Math.min(limit, 2_000)))
      .map((line) => JSON.parse(line) as AuditEntry)
      .reverse();
  }

  /** Test/dev helper: list package directories. */
  packageVersions(id: string): string[] {
    const dir = join(this.dataDir, 'packages', id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  }

  private requireRecord(id: string, version: string): VersionRecord {
    const record = this.getRecord(id, version);
    if (record === undefined) {
      throw new Error(`skill ${id}@${version} not found`);
    }
    return record;
  }
}
