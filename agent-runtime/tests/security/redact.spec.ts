import { describe, expect, it } from 'vitest';
import { redactDeep, redactSecrets } from '../../src/security/redact.js';

describe('redactSecrets', () => {
  it('replaces all occurrences', () => {
    expect(
      redactSecrets('key=sk-secret and sk-secret again', ['sk-secret'])
    ).toBe('key=*** and *** again');
  });

  it('replaces longer secrets first', () => {
    expect(redactSecrets('abcdef', ['abc', 'abcdef'])).toBe('***');
    expect(redactSecrets('abcdef', ['abcdef', 'abc'])).toBe('***');
  });

  it('ignores empty secrets and empty secret lists', () => {
    expect(redactSecrets('unchanged', [])).toBe('unchanged');
    expect(redactSecrets('unchanged', [''])).toBe('unchanged');
  });

  it('deduplicates secrets', () => {
    expect(redactSecrets('token token', ['token', 'token'])).toBe('*** ***');
  });

  it('does not treat secrets as regexes', () => {
    expect(redactSecrets('a.b aXb', ['a.b'])).toBe('*** aXb');
  });
});

describe('redactDeep', () => {
  it('redacts nested values and keys without mutating the input', () => {
    const input = {
      token: 'sk-secret',
      nested: {
        note: 'contains sk-secret',
        'sk-secret-key': 'value',
      },
      list: ['sk-secret', 42, { deep: 'sk-secret' }],
    };
    const snapshot = JSON.parse(JSON.stringify(input));

    const result = redactDeep(input, ['sk-secret']);

    expect(result).toEqual({
      token: '***',
      nested: {
        note: 'contains ***',
        '***-key': 'value',
      },
      list: ['***', 42, { deep: '***' }],
    });
    expect(input).toEqual(snapshot);
  });

  it('handles cycles', () => {
    const input: Record<string, unknown> = { token: 'sk-secret' };
    input.self = input;

    const result = redactDeep(input, ['sk-secret']) as Record<string, unknown>;

    expect(result.token).toBe('***');
    expect(result.self).toBe(result);
  });

  it('returns the input unchanged when there are no secrets', () => {
    const input = { token: 'sk-secret' };
    expect(redactDeep(input, [])).toBe(input);
  });

  it('leaves non-plain objects untouched', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(redactDeep({ date }, ['2026']).date).toBe(date);
  });
});
