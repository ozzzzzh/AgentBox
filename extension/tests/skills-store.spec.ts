import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSkillPackage } from '../src/skills/model';
import {
  deleteLocalSkill,
  readLocalSkills,
  readRemoteSkills,
  remoteServerHash,
  scaffoldLocalSkill,
  writeRemoteIndex,
  writeRemoteSkill,
} from '../src/skills/store';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const manifest = {
  schemaVersion: 1 as const,
  id: 'team-encoding',
  name: 'Team encoding',
  version: '1.0.0',
  description: 'encoding rules',
  owner: 'platform',
  activation: 'always' as const,
  priority: 100,
  budget: { maxChars: 2000 },
  required: false,
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('skill store', () => {
  it('scaffolds, reads, and deletes a local skill', () => {
    const root = tempDir('agentbox-skills-');
    const created = scaffoldLocalSkill(root, {
      id: 'team-encoding',
      name: 'Team encoding',
      owner: 'platform',
    });
    expect(created.skill.manifest.id).toBe('team-encoding');

    const read = readLocalSkills(root);
    expect(read.errors).toEqual([]);
    expect(read.items).toHaveLength(1);
    expect(read.items[0]?.skill.manifest.version).toBe('0.1.0');

    deleteLocalSkill(root, 'team-encoding');
    expect(readLocalSkills(root).items).toHaveLength(0);
  });

  it('loads a markdown-only skill directory without skill.json', () => {
    const root = tempDir('agentbox-skills-');
    const dir = join(root, 'hello-world');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        'name: Hello World',
        'description: A simple greeting skill.',
        '---',
        '',
        '# Hello World',
        '',
        'Say hello.',
        '',
      ].join('\n'),
      'utf8'
    );
    writeFileSync(join(dir, 'query.sql'), 'SELECT 1;', 'utf8');

    const read = readLocalSkills(root);
    expect(read.errors).toEqual([]);
    expect(read.items).toHaveLength(1);
    const skill = read.items[0]!.skill;
    expect(skill.manifest.id).toBe('hello-world');
    expect(skill.manifest.name).toBe('Hello World');
    expect(skill.manifest.description).toBe('A simple greeting skill.');
    expect(skill.files['SKILL.md']).not.toContain('name: Hello World');
    expect(skill.files['query.sql']).toBe('SELECT 1;');
  });

  it('reports invalid local packages without throwing', () => {
    const root = tempDir('agentbox-skills-');
    scaffoldLocalSkill(root, {
      id: 'valid-skill',
      name: 'Valid',
      owner: 'me',
    });
    const read = readLocalSkills(root);
    expect(read.items).toHaveLength(1);
    expect(read.errors).toEqual([]);
  });

  it('writes and reads a verified remote cache', () => {
    const globalStorage = tempDir('agentbox-global-');
    const serverUrl = 'https://skills.example.test';
    const skill = createSkillPackage(manifest, {
      'SKILL.md': '# Team encoding\n',
    });

    writeRemoteSkill(globalStorage, serverUrl, skill);
    writeRemoteIndex(globalStorage, {
      serverUrl,
      updatedAt: new Date().toISOString(),
      skills: [
        {
          id: skill.manifest.id,
          version: skill.manifest.version,
          required: true,
          hash: skill.hash,
        },
      ],
    });

    const read = readRemoteSkills(globalStorage, serverUrl);
    expect(read.errors).toEqual([]);
    expect(read.items).toHaveLength(1);
    expect(read.items[0]?.required).toBe(true);
    expect(read.items[0]?.skill.hash).toBe(skill.hash);
    expect(remoteServerHash(serverUrl)).toHaveLength(16);
  });

  it('rejects a cached package with a wrong hash', () => {
    const globalStorage = tempDir('agentbox-global-');
    const serverUrl = 'https://skills.example.test';
    const skill = createSkillPackage(manifest, {
      'SKILL.md': '# Team encoding\n',
    });
    writeRemoteSkill(globalStorage, serverUrl, skill);
    writeRemoteIndex(globalStorage, {
      serverUrl,
      updatedAt: new Date().toISOString(),
      skills: [
        {
          id: skill.manifest.id,
          version: skill.manifest.version,
          required: true,
          hash: '0'.repeat(64),
        },
      ],
    });

    const read = readRemoteSkills(globalStorage, serverUrl);
    expect(read.items).toHaveLength(0);
    expect(read.errors[0]?.message).toMatch(/hash mismatch/);
  });
});
