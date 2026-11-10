import {
  skillContent,
  usageOf,
  type SkillPackage,
  type SkillUsage,
} from './model';

export interface SkillCandidate {
  skill: SkillPackage;
  source: 'local' | 'remote';
  required: boolean;
}

export interface SkillInjectionBudget {
  requiredChars: number;
  optionalChars: number;
  totalChars: number;
}

export interface SkillInjection {
  requiredText: string;
  optionalText: string;
  usage: SkillUsage[];
  warnings: string[];
}

const DEFAULT_BUDGET: SkillInjectionBudget = {
  requiredChars: 4_000,
  optionalChars: 8_000,
  totalChars: 12_000,
};

function normalizeBudget(
  budget: Partial<SkillInjectionBudget> | undefined
): SkillInjectionBudget {
  const merged = { ...DEFAULT_BUDGET, ...(budget ?? {}) };
  return {
    requiredChars: Math.max(0, merged.requiredChars),
    optionalChars: Math.max(0, merged.optionalChars),
    totalChars: Math.max(0, merged.totalChars),
  };
}

function sortCandidates(a: SkillCandidate, b: SkillCandidate): number {
  const priority = b.skill.manifest.priority - a.skill.manifest.priority;
  if (priority !== 0) return priority;
  return a.skill.manifest.id.localeCompare(b.skill.manifest.id);
}

function sectionFor(skill: SkillPackage): string {
  const { id, version } = skill.manifest;
  return [`[skill ${id}@${version}]`, skillContent(skill).trim(), `[/skill]`].join(
    '\n'
  );
}

function takeWithinBudget(
  candidates: SkillCandidate[],
  limit: number,
  startUsed: number,
  totalLimit: number,
  warnings: string[],
  usage: SkillUsage[]
): string {
  const sections: string[] = [];
  let used = startUsed;
  for (const candidate of candidates) {
    const { id, version } = candidate.skill.manifest;
    const section = sectionFor(candidate.skill);
    const maxForSkill = Math.min(
      candidate.skill.manifest.budget.maxChars,
      limit - (used - startUsed),
      totalLimit - used
    );
    if (maxForSkill <= 0) {
      warnings.push(`skill ${id}@${version} 超出预算，已跳过`);
      continue;
    }
    let text = section;
    if (text.length > maxForSkill) {
      const keep = Math.max(0, maxForSkill - 20);
      text = `${text.slice(0, keep).trimEnd()}\n…（已截断）`;
      warnings.push(`skill ${id}@${version} 超出预算，已截断`);
    }
    sections.push(text);
    used += text.length;
    usage.push({
      ...usageOf(candidate.skill, candidate.source),
      required: candidate.required,
    });
  }
  return sections.join('\n\n');
}

/**
 * Resolve required remote skills and enabled local/optional skills into
 * developer-instruction sections. Remote required skills win over a local
 * package with the same id.
 */
export function buildSkillInjection(input: {
  local: SkillPackage[];
  remote: Array<{ skill: SkillPackage; required: boolean }>;
  enabledIds?: Iterable<string>;
  disabledIds?: Iterable<string>;
  budget?: Partial<SkillInjectionBudget>;
}): SkillInjection {
  const budget = normalizeBudget(input.budget);
  const warnings: string[] = [];
  const enabled = new Set(input.enabledIds ?? []);
  const disabled = new Set(input.disabledIds ?? []);
  const usage: SkillUsage[] = [];

  const required = input.remote
    .filter((item) => item.required)
    .map<SkillCandidate>((item) => ({
      skill: item.skill,
      source: 'remote',
      required: true,
    }));
  const requiredIds = new Set(required.map((item) => item.skill.manifest.id));

  const local = input.local
    .filter((skill) => {
      if (requiredIds.has(skill.manifest.id)) {
        warnings.push(
          `local skill ${skill.manifest.id} 被 remote required 同名 skill 覆盖`
        );
        return false;
      }
      if (disabled.has(skill.manifest.id)) return false;
      return (
        skill.manifest.activation === 'always' ||
        enabled.has(skill.manifest.id)
      );
    })
    .map<SkillCandidate>((skill) => ({
      skill,
      source: 'local',
      required: false,
    }));

  const optional = input.remote
    .filter(
      (item) =>
        !item.required &&
        !disabled.has(item.skill.manifest.id) &&
        (item.skill.manifest.activation === 'always' ||
          enabled.has(item.skill.manifest.id))
    )
    .map<SkillCandidate>((item) => ({
      skill: item.skill,
      source: 'remote',
      required: false,
    }));

  required.sort(sortCandidates);
  local.sort(sortCandidates);
  optional.sort(sortCandidates);

  const requiredText = takeWithinBudget(
    required,
    budget.requiredChars,
    0,
    budget.totalChars,
    warnings,
    usage
  );
  const optionalText = takeWithinBudget(
    [...local, ...optional].sort(sortCandidates),
    budget.optionalChars,
    requiredText.length,
    budget.totalChars,
    warnings,
    usage
  );

  return { requiredText, optionalText, usage, warnings };
}
