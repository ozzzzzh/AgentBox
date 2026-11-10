import {
  skillContent,
  usageOf,
  type SkillPackage,
  type SkillUsage,
} from './model';

const MENTION_RE = /(?:^|\s)@([a-z0-9][a-z0-9._-]{2,63})(?=\s|$|[,.;:!?，。；：！？])/g;
const DEFAULT_MENTION_BUDGET = 12_000;

export interface MentionCandidate {
  skill: SkillPackage;
  source: 'local' | 'remote';
}

export function extractSkillMentions(prompt: string): string[] {
  const ids = new Set<string>();
  for (const match of prompt.matchAll(MENTION_RE)) {
    if (match[1] !== undefined) ids.add(match[1]);
  }
  return [...ids];
}

/**
 * Build one-turn context for explicitly mentioned skills. Mentions are not
 * persisted and do not change the passive skill selection.
 */
export function buildMentionedSkillContext(input: {
  skills: MentionCandidate[];
  alreadyInjected: SkillUsage[];
  maxChars?: number;
}): { text: string; usage: SkillUsage[]; warnings: string[] } {
  const already = new Set(input.alreadyInjected.map((item) => item.id));
  const byId = new Map<string, MentionCandidate>();
  for (const candidate of input.skills) {
    if (already.has(candidate.skill.manifest.id)) continue;
    if (!byId.has(candidate.skill.manifest.id)) {
      byId.set(candidate.skill.manifest.id, candidate);
    }
  }

  const candidates = [...byId.values()].sort((a, b) => {
    const priority = b.skill.manifest.priority - a.skill.manifest.priority;
    return priority !== 0
      ? priority
      : a.skill.manifest.id.localeCompare(b.skill.manifest.id);
  });

  const maxChars = Math.max(200, input.maxChars ?? DEFAULT_MENTION_BUDGET);
  const sections: string[] = [];
  const usage: SkillUsage[] = [];
  const warnings: string[] = [];
  let used = 0;

  for (const candidate of candidates) {
    const { id, version } = candidate.skill.manifest;
    const remaining = maxChars - used;
    if (remaining <= 0) {
      warnings.push(`mentioned skill ${id}@${version} 超出预算，已跳过`);
      continue;
    }
    const limit = Math.min(candidate.skill.manifest.budget.maxChars, remaining);
    let text = `[skill ${id}@${version}]\n${skillContent(candidate.skill).trim()}\n[/skill]`;
    if (text.length > limit) {
      text = `${text.slice(0, Math.max(0, limit - 20)).trimEnd()}\n…（已截断）`;
      warnings.push(`mentioned skill ${id}@${version} 超出预算，已截断`);
    }
    sections.push(text);
    used += text.length;
    usage.push({
      ...usageOf(candidate.skill, candidate.source),
      required: false,
    });
  }

  return {
    text:
      sections.length === 0
        ? ''
        : [
            'Skills explicitly mentioned for this turn (use them as guidance):',
            sections.join('\n\n'),
          ].join('\n'),
    usage,
    warnings,
  };
}
