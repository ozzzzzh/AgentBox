import { describe, expect, it } from 'vitest';
import {
  SkillValidationError,
  computeSkillHash,
  createSkillPackage,
  parseSkillManifest,
  parseSkillPackage,
} from '../src/skills/model';

const manifest = {
  schemaVersion: 1,
  id: 'team-encoding',
  name: 'Team encoding',
  version: '1.0.0',
  description: 'encoding rules',
  owner: 'platform',
  activation: 'always',
  priority: 100,
  budget: { maxChars: 2000 },
  required: false,
};

describe('skill model', () => {
  it('normalizes a valid manifest and package', () => {
    const parsed = parseSkillManifest(manifest);
    expect(parsed.id).toBe('team-encoding');
    expect(parsed.activation).toBe('always');
    expect(parsed.required).toBe(false);

    const skill = createSkillPackage(manifest, {
      'SKILL.md': '# Rules\n\n- use strict\n',
      'references/naming.md': '# naming\n',
    });
    expect(skill.hash).toHaveLength(64);
    expect(parseSkillPackage(skill)).toEqual(skill);
    expect(computeSkillHash(skill.manifest, skill.files)).toBe(skill.hash);
  });

  it('rejects invalid ids and versions', () => {
    expect(() =>
      parseSkillManifest({ ...manifest, id: '../escape' })
    ).toThrow(SkillValidationError);
    expect(() =>
      parseSkillManifest({ ...manifest, version: 'latest' })
    ).toThrow(SkillValidationError);
  });

  it('rejects path traversal and unsupported files', () => {
    expect(() =>
      createSkillPackage(manifest, {
        'SKILL.md': '# ok',
        '../secret.md': 'x',
      })
    ).toThrow(/must not contain/);
    expect(() =>
      createSkillPackage(manifest, {
        'SKILL.md': '# ok',
        'run.exe': 'x',
      })
    ).toThrow(/unsupported file extension/);
  });

  it('requires SKILL.md and detects a hash mismatch', () => {
    expect(() =>
      createSkillPackage(manifest, { 'references/a.md': 'x' })
    ).toThrow(/SKILL\.md is required/);

    const skill = createSkillPackage(manifest, { 'SKILL.md': '# ok' });
    expect(() =>
      parseSkillPackage({ ...skill, hash: '0'.repeat(64) })
    ).toThrow(/hash mismatch/);
  });
});
