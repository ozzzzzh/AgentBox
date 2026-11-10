import { describe, expect, it } from 'vitest';
import { createSkillPackage } from '../src/skills/model';
import { buildSkillInjection } from '../src/skills/injection';

function skill(
  id: string,
  opts: {
    version?: string;
    activation?: 'always' | 'on-demand' | 'manual';
    priority?: number;
    required?: boolean;
    content?: string;
  } = {}
) {
  return createSkillPackage(
    {
      schemaVersion: 1,
      id,
      name: id,
      version: opts.version ?? '1.0.0',
      description: `${id} description`,
      owner: 'team',
      activation: opts.activation ?? 'always',
      priority: opts.priority ?? 50,
      budget: { maxChars: 4000 },
      required: opts.required ?? false,
    },
    { 'SKILL.md': opts.content ?? `# ${id}\n` }
  );
}

describe('skill injection', () => {
  it('puts remote required before local skills and deduplicates by id', () => {
    const remote = skill('team-encoding', {
      required: true,
      content: '# Remote required',
    });
    const local = skill('team-encoding', { content: '# Local duplicate' });
    const localOnly = skill('my-style', { content: '# Local style' });

    const result = buildSkillInjection({
      local: [local, localOnly],
      remote: [{ skill: remote, required: true }],
    });

    expect(result.requiredText).toContain('Remote required');
    expect(result.requiredText).not.toContain('Local duplicate');
    expect(result.optionalText).toContain('Local style');
    expect(result.usage.map((item) => `${item.id}:${item.source}`)).toEqual([
      'team-encoding:remote',
      'my-style:local',
    ]);
    expect(result.warnings.join('\n')).toMatch(/被 remote required.*覆盖/);
  });

  it('includes enabled on-demand local skills and skips disabled ones', () => {
    const enabled = skill('enabled-skill', { activation: 'on-demand' });
    const disabled = skill('disabled-skill', { activation: 'manual' });

    const result = buildSkillInjection({
      local: [enabled, disabled],
      remote: [],
      enabledIds: ['enabled-skill'],
    });

    expect(result.optionalText).toContain('enabled-skill');
    expect(result.optionalText).not.toContain('disabled-skill');
    expect(result.usage).toHaveLength(1);
  });

  it('suppresses explicitly disabled local skills', () => {
    const skillAlways = skill('always-skill', { activation: 'always' });
    const result = buildSkillInjection({
      local: [skillAlways],
      remote: [],
      disabledIds: ['always-skill'],
    });
    expect(result.optionalText).not.toContain('always-skill');
    expect(result.usage).toEqual([]);
  });

  it('orders by priority', () => {
    const high = skill('high-priority', {
      priority: 100,
      content: '# High',
    });
    const low = skill('low-priority', { priority: 1, content: '# Low' });

    const result = buildSkillInjection({
      local: [low, high],
      remote: [],
    });

    expect(result.optionalText.indexOf('high-priority')).toBeLessThan(
      result.optionalText.indexOf('low-priority')
    );
  });

  it('truncates a skill over its budget', () => {
    const large = skill('large-skill', {
      content: `# Large\n${'a'.repeat(5000)}`,
    });

    const result = buildSkillInjection({
      local: [large],
      remote: [],
      budget: { optionalChars: 600, totalChars: 600 },
    });

    expect(result.optionalText).toContain('large-skill');
    expect(result.optionalText).toContain('已截断');
    expect(result.warnings.join('\n')).toMatch(/超出预算/);
  });
});
