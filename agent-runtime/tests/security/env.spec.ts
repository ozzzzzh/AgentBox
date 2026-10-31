import { describe, expect, it } from 'vitest';
import { buildChildEnv } from '../../src/security/env.js';

describe('buildChildEnv', () => {
  it('inherits only the allowlist and drops secrets', () => {
    const env = buildChildEnv({
      PATH: '/bin',
      HOME: '/home/dev',
      MODEL_API_KEY: 'sk-secret',
      RANDOM_VAR: 'nope',
    });

    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/dev');
    expect(env.MODEL_API_KEY).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  it('includes extra variables only when explicitly passed', () => {
    const env = buildChildEnv(
      { MODEL_API_KEY: 'sk-parent' },
      { MODEL_API_KEY: 'sk-child' }
    );
    expect(env.MODEL_API_KEY).toBe('sk-child');
  });

  it('lets extra variables override allowlisted values', () => {
    const env = buildChildEnv({ PATH: '/bin' }, { PATH: '/custom' });
    expect(env.PATH).toBe('/custom');
  });

  it('supports additional allowlist entries', () => {
    const env = buildChildEnv({ CUSTOM_VAR: 'value' }, {}, ['CUSTOM_VAR']);
    expect(env.CUSTOM_VAR).toBe('value');
  });

  it('skips undefined values and keeps empty strings', () => {
    const env = buildChildEnv(
      { PATH: undefined, HOME: '/home/dev' },
      { EMPTY: '' }
    );
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBe('/home/dev');
    expect(env.EMPTY).toBe('');
  });

  it('does not mutate the parent environment', () => {
    const parent = { PATH: '/bin', MODEL_API_KEY: 'sk-parent' };
    const snapshot = { ...parent };

    buildChildEnv(parent, { MODEL_API_KEY: 'sk-child' });

    expect(parent).toEqual(snapshot);
  });

  it.skipIf(process.platform !== 'win32')(
    'matches Windows environment keys case-insensitively',
    () => {
      const env = buildChildEnv({ SystemRoot: 'C:\\Windows' });
      expect(env.SYSTEMROOT).toBe('C:\\Windows');
    }
  );
});
