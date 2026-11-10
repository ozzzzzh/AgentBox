import {
  parseSkillPackage,
  serializeSkillPackage,
  type SkillPackage,
} from './model';
import {
  writeRemoteIndex,
  writeRemoteSkill,
  type RemoteCacheIndex,
} from './store';

export interface RemoteSkillSummary {
  id: string;
  version: string;
  required: boolean;
  enabled?: boolean;
  groups?: string[];
  hash: string;
  name?: string;
  description?: string;
  owner?: string;
}

export interface ClientGroupInfo {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  membership: 'none' | 'pending' | 'approved' | 'rejected';
}

export interface SkillUploadResult {
  id: string;
  version: string;
  status: 'pending' | 'approved' | 'rejected';
  hash: string;
}

export class SkillServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'SkillServerError';
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export class SkillServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly clientId?: string,
    private readonly clientName?: string
  ) {
    if (baseUrl.trim() === '') {
      throw new Error('Skill server URL is not configured');
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(joinUrl(this.baseUrl, path), {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
          ...(this.token !== undefined && this.token !== ''
            ? { authorization: `Bearer ${this.token}` }
            : {}),
          ...(this.clientId !== undefined && this.clientId !== ''
            ? {
                'x-agentbox-client': this.clientId,
                ...(this.clientName !== undefined && this.clientName !== ''
                  ? { 'x-agentbox-client-name': this.clientName }
                  : {}),
              }
            : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let value: unknown;
      try {
        value = text === '' ? undefined : JSON.parse(text);
      } catch {
        value = undefined;
      }
      if (!response.ok) {
        const record =
          typeof value === 'object' && value !== null
            ? (value as { error?: { code?: string; message?: string } })
            : {};
        throw new SkillServerError(
          record.error?.message ?? `Skill server HTTP ${response.status}`,
          response.status,
          record.error?.code
        );
      }
      return value as T;
    } catch (error) {
      if (error instanceof SkillServerError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SkillServerError('Skill server request timed out');
      }
      throw new SkillServerError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async listApproved(): Promise<RemoteSkillSummary[]> {
    const value = await this.request<{ skills?: RemoteSkillSummary[] }>(
      '/v1/skills?status=approved'
    );
    return Array.isArray(value.skills) ? value.skills : [];
  }

  async required(): Promise<RemoteSkillSummary[]> {
    const value = await this.request<{ skills?: RemoteSkillSummary[] }>(
      '/v1/required'
    );
    return Array.isArray(value.skills) ? value.skills : [];
  }

  async download(id: string, version: string): Promise<SkillPackage> {
    const value = await this.request<unknown>(
      `/v1/skills/${encodeURIComponent(id)}/${encodeURIComponent(version)}`
    );
    return parseSkillPackage(value);
  }

  async listClientGroups(): Promise<ClientGroupInfo[]> {
    const value = await this.request<{ groups?: ClientGroupInfo[] }>(
      '/v1/client/groups'
    );
    return Array.isArray(value.groups) ? value.groups : [];
  }

  async requestGroup(groupId: string): Promise<unknown> {
    return this.request(
      `/v1/client/groups/${encodeURIComponent(groupId)}/request`,
      { method: 'POST', body: JSON.stringify({}) }
    );
  }

  async upload(skill: SkillPackage): Promise<SkillUploadResult> {
    const value = await this.request<SkillUploadResult>('/v1/skills', {
      method: 'POST',
      body: JSON.stringify(serializeSkillPackage(skill)),
    });
    return value;
  }
}

export interface SyncResult {
  index: RemoteCacheIndex;
  warnings: string[];
}

/**
 * Download approved remote skills into the fixed global cache. Required
 * packages are marked in the index and injected on every turn.
 */
export async function syncRemoteSkills(
  globalStorage: string,
  serverUrl: string,
  token?: string,
  clientId?: string,
  clientName?: string
): Promise<SyncResult> {
  const client = new SkillServerClient(serverUrl, token, clientId, clientName);
  const summaries = await client.listApproved();
  const warnings: string[] = [];
  const skills: RemoteCacheIndex['skills'] = [];

  for (const summary of summaries) {
    if (summary.enabled === false) continue;
    try {
      const skill = await client.download(summary.id, summary.version);
      if (skill.hash !== summary.hash) {
        throw new Error(
          `hash mismatch for ${summary.id}@${summary.version}`
        );
      }
      if (
        skill.manifest.id !== summary.id ||
        skill.manifest.version !== summary.version
      ) {
        throw new Error(
          `id/version mismatch for ${summary.id}@${summary.version}`
        );
      }
      writeRemoteSkill(globalStorage, serverUrl, skill);
      skills.push({
        id: skill.manifest.id,
        version: skill.manifest.version,
        required: summary.required,
        hash: skill.hash,
        ...(summary.groups === undefined ? {} : { groups: summary.groups }),
      });
    } catch (error) {
      warnings.push(
        `${summary.id}@${summary.version}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const index: RemoteCacheIndex = {
    serverUrl,
    updatedAt: new Date().toISOString(),
    skills,
  };
  writeRemoteIndex(globalStorage, index);
  return { index, warnings };
}
