import { describe, expect, it } from 'vitest';
import {
  limitsForTaskProfile,
  normalizeTaskProfile,
} from '../src/task-profile';

describe('task profiles', () => {
  it('defines simple, code and research budgets', () => {
    expect(limitsForTaskProfile('simple')).toEqual({
      maxSteps: 8,
      maxToolCallsPerTurn: 10,
      turnTimeoutMs: 90_000,
    });
    expect(limitsForTaskProfile('code')).toEqual({
      maxSteps: 20,
      maxToolCallsPerTurn: 30,
      turnTimeoutMs: 180_000,
    });
    expect(limitsForTaskProfile('research')).toEqual({
      maxSteps: 30,
      maxToolCallsPerTurn: 40,
      turnTimeoutMs: 300_000,
    });
  });

  it('falls back to code for unknown values', () => {
    expect(normalizeTaskProfile(undefined)).toBe('code');
    expect(normalizeTaskProfile('unknown')).toBe('code');
    expect(normalizeTaskProfile('simple')).toBe('simple');
    expect(normalizeTaskProfile('research')).toBe('research');
  });
});
