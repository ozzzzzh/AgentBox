import { describe, expect, it } from 'vitest';
import { buildSkillCatalog } from '../src/skills/catalog';
import { createSkillPackage } from '../src/skills/model';

function skill(
  id: string,
  activation: 'always' | 'on-demand' | 'manual' = 'always'
) {
  return createSkillPackage(
    {
      schemaVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      description: `${id} description`,
      owner: 'team',
      activation,
      priority: 50,
      budget: { maxChars: 2000 },
      required: false,
    },
    { 'SKILL.md': `# ${id}\n` }
  );
}

describe('skill catalog', () => {
  it('marks required remote skills active and local always skills active', () => {
    const required = skill('team-encoding');
    const local = skill('my-skill');
    const items = buildSkillCatalog({
      local: [local],
      remote: [{ skill: required, required: true }],
    });

    expect(items.map((item) => `${item.id}:${item.required}:${item.active}`)).toEqual([
      'team-encoding:true:true',
      'my-skill:false:true',
    ]);
  });

  it('respects enabled/disabled and remote required precedence', () => {
    const remote = skill('same-id');
    const localSame = skill('same-id');
    const optional = skill('optional', 'on-demand');
    const items = buildSkillCatalog({
      local: [localSame, optional],
      remote: [{ skill: remote, required: true }],
      enabledIds: ['optional'],
      disabledIds: ['optional'],
    });

    expect(items.find((item) => item.id === 'same-id')?.source).toBe('remote');
    expect(items.find((item) => item.id === 'same-id')?.required).toBe(true);
    expect(items.find((item) => item.id === 'optional')?.active).toBe(false);
  });
});
