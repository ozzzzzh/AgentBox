import type { SkillPackage } from './model';

export interface SkillCatalogItem {
  id: string;
  name: string;
  version: string;
  description: string;
  source: 'local' | 'remote';
  required: boolean;
  active: boolean;
  groups?: string[];
}

export interface SkillCatalogInput {
  local: SkillPackage[];
  remote: Array<{
    skill: SkillPackage;
    required: boolean;
    groups?: string[];
  }>;
  enabledIds?: Iterable<string>;
  disabledIds?: Iterable<string>;
}

/**
 * Build the checkbox list shown in the skill drawer. Required remote skills are
 * always active and cannot be toggled off. A remote required skill with the
 * same id as a local skill wins, matching injection precedence.
 */
export function buildSkillCatalog(input: SkillCatalogInput): SkillCatalogItem[] {
  const enabled = new Set(input.enabledIds ?? []);
  const disabled = new Set(input.disabledIds ?? []);
  const items: SkillCatalogItem[] = [];
  const requiredIds = new Set(
    input.remote.filter((item) => item.required).map((item) => item.skill.manifest.id)
  );

  for (const item of input.remote) {
    const { manifest } = item.skill;
    const active =
      item.required ||
      (!disabled.has(manifest.id) &&
        (manifest.activation === 'always' || enabled.has(manifest.id)));
    items.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source: 'remote',
      required: item.required,
      active,
      ...(item.groups === undefined ? {} : { groups: item.groups }),
    });
  }

  for (const skill of input.local) {
    const { manifest } = skill;
    if (requiredIds.has(manifest.id)) continue;
    const active =
      !disabled.has(manifest.id) &&
      (manifest.activation === 'always' || enabled.has(manifest.id));
    items.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source: 'local',
      required: false,
      active,
    });
  }

  items.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return `${a.source}:${a.id}`.localeCompare(`${b.source}:${b.id}`);
  });
  return items;
}
