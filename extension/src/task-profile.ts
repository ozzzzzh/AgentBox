import type { Limits } from '@agentbox/runtime';

export type TaskProfileId = 'simple' | 'code' | 'research';

export const TASK_PROFILE_IDS: TaskProfileId[] = [
  'simple',
  'code',
  'research',
];

interface TaskProfile {
  label: string;
  limits: Partial<Limits>;
}

export const TASK_PROFILES: Record<TaskProfileId, TaskProfile> = {
  simple: {
    label: '简单文件（静态 HTML/CSS/单文件）',
    limits: {
      turnTimeoutMs: 90_000,
    },
  },
  code: {
    label: '常规编码',
    limits: {
      turnTimeoutMs: 180_000,
    },
  },
  research: {
    label: '研究/多步任务',
    limits: {
      turnTimeoutMs: 300_000,
    },
  },
};

export function normalizeTaskProfile(
  value: string | undefined
): TaskProfileId {
  return value === 'simple' || value === 'research' ? value : 'code';
}

export function limitsForTaskProfile(
  profile: TaskProfileId
): Partial<Limits> {
  return { ...TASK_PROFILES[profile].limits };
}
