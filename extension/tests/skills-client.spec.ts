import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSkillPackage } from '../src/skills/model';
import { SkillServerClient, syncRemoteSkills } from '../src/skills/client';
import { readRemoteIndex, readRemoteSkills } from '../src/skills/store';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function pkg(id = 'team-encoding') {
  return createSkillPackage(
    {
      schemaVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      description: 'rules',
      owner: 'team',
      activation: 'always',
      priority: 50,
      budget: { maxChars: 4000 },
      required: false,
    },
    { 'SKILL.md': `# ${id}\n` }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('skill server client', () => {
  it('syncs approved packages and marks required entries', async () => {
    const globalStorage = tempDir('agentbox-global-');
    const serverUrl = 'https://skills.example.test';
    const skill = pkg();

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/skills?status=approved')) {
        return new Response(
          JSON.stringify({
            skills: [
              {
                id: skill.manifest.id,
                version: skill.manifest.version,
                required: true,
                hash: skill.hash,
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/v1/skills/team-encoding/1.0.0')) {
        return new Response(JSON.stringify(skill), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncRemoteSkills(globalStorage, serverUrl, 'token');

    expect(result.warnings).toEqual([]);
    expect(result.index.skills).toEqual([
      {
        id: 'team-encoding',
        version: '1.0.0',
        required: true,
        hash: skill.hash,
      },
    ]);
    expect(readRemoteIndex(globalStorage, serverUrl)?.skills[0]?.required).toBe(
      true
    );
    const cached = readRemoteSkills(globalStorage, serverUrl);
    expect(cached.errors).toEqual([]);
    expect(cached.items[0]?.required).toBe(true);
    expect(cached.items[0]?.skill.hash).toBe(skill.hash);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://skills.example.test/v1/skills?status=approved',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer token',
        }),
      })
    );
  });

  it('reports a hash mismatch as a sync warning', async () => {
    const globalStorage = tempDir('agentbox-global-');
    const serverUrl = 'https://skills.example.test';
    const skill = pkg();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/v1/skills?status=approved')) {
          return new Response(
            JSON.stringify({
              skills: [
                {
                  id: skill.manifest.id,
                  version: skill.manifest.version,
                  required: true,
                  hash: '0'.repeat(64),
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify(skill), { status: 200 });
      })
    );

    const result = await syncRemoteSkills(globalStorage, serverUrl);
    expect(result.index.skills).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/hash mismatch/);
  });

  it('uploads a package and returns pending status', async () => {
    const skill = pkg();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: skill.manifest.id,
          version: skill.manifest.version,
          status: 'pending',
          hash: skill.hash,
        }),
        { status: 201 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new SkillServerClient(
      'https://skills.example.test',
      'token'
    ).upload(skill);

    expect(result.status).toBe('pending');
    const call = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(call[0]).toBe('https://skills.example.test/v1/skills');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body).manifest.id).toBe('team-encoding');
  });
});

  it('skips versions the server has not pushed to agents', async () => {
    const globalStorage = tempDir('agentbox-global-');
    const serverUrl = 'https://skills.example.test';
    const skill = pkg();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/v1/skills?status=approved')) {
          return new Response(
            JSON.stringify({
              skills: [
                {
                  id: skill.manifest.id,
                  version: skill.manifest.version,
                  required: false,
                  enabled: false,
                  hash: skill.hash,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify(skill), { status: 200 });
      })
    );

    const result = await syncRemoteSkills(globalStorage, serverUrl);
    expect(result.index.skills).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(readRemoteSkills(globalStorage, serverUrl).items).toEqual([]);
  });

  it('requests group membership with the client identity', async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        if (url.endsWith('/v1/client/groups')) {
          return new Response(
            JSON.stringify({
              groups: [
                {
                  id: 'backend',
                  name: 'Backend',
                  description: '',
                  skillIds: ['team-encoding'],
                  membership: 'none',
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ status: 'pending' }), {
          status: 200,
        });
      })
    );

    const client = new SkillServerClient(
      'https://skills.example.test',
      'token',
      'client-123',
      'workspace @ host'
    );
    const groups = await client.listClientGroups();
    expect(groups[0]?.membership).toBe('none');
    await client.requestGroup('backend');

    expect(calls[0]?.[0]).toBe(
      'https://skills.example.test/v1/client/groups'
    );
    expect(calls[0]?.[1].headers).toMatchObject({
      'x-agentbox-client': 'client-123',
      'x-agentbox-client-name': 'workspace @ host',
    });
    expect(calls[1]?.[0]).toBe(
      'https://skills.example.test/v1/client/groups/backend/request'
    );
    expect(calls[1]?.[1].method).toBe('POST');
  });
