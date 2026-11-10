import { describe, expect, it } from 'vitest';
import { createSkillPackage } from '../src/skills/model';
import {
  buildMentionedSkillContext,
  extractSkillMentions,
} from '../src/skills/mentions';

function skill(id: string, content = `# ${id}\n`) {
  return createSkillPackage(
    {
      schemaVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      description: `${id} description`,
      owner: 'team',
      activation: 'on-demand',
      priority: 50,
      budget: { maxChars: 4000 },
      required: false,
    },
    { 'SKILL.md': content }
  );
}

describe('skill mentions', () => {
  it('extracts unique valid ids and ignores email/code noise', () => {
    expect(
      extractSkillMentions(
        'use @team-encoding and @hello.world, then @team-encoding again'
      )
    ).toEqual(['team-encoding', 'hello.world']);
    expect(extractSkillMentions('mail me at foo@bar.com')).toEqual([]);
  });

  it('builds one-turn context and skips already injected skills', () => {
    const encoding = skill('team-encoding', '# Encoding');
    const result = buildMentionedSkillContext({
      skills: [
        { skill: encoding, source: 'remote' },
        { skill: skill('already-on'), source: 'local' },
      ],
      alreadyInjected: [
        {
          id: 'already-on',
          version: '1.0.0',
          hash: 'hash',
          source: 'local',
          required: false,
        },
      ],
    });

    expect(result.text).toContain('team-encoding');
    expect(result.text).toContain('# Encoding');
    expect(result.text).not.toContain('already-on');
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]?.id).toBe('team-encoding');
  });

  it('truncates over budget', () => {
    const result = buildMentionedSkillContext({
      skills: [{ skill: skill('large', 'x'.repeat(5000)), source: 'local' }],
      alreadyInjected: [],
      maxChars: 600,
    });
    expect(result.text).toContain('已截断');
    expect(result.warnings.join('\n')).toMatch(/超出预算/);
  });
});
