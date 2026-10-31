/**
 * Redaction helpers for events and logs.
 *
 * Secrets are matched literally (not as regexes). Longer secrets are replaced
 * first so a shorter prefix cannot leave part of the secret behind.
 */

const MASK = '***';

function normalizeSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets)]
    .filter((secret) => typeof secret === 'string' && secret.length > 0)
    .sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of each secret with `***`. */
export function redactSecrets(
  text: string,
  secrets: readonly string[]
): string {
  const normalized = normalizeSecrets(secrets);
  if (normalized.length === 0) return text;

  let result = text;
  for (const secret of normalized) {
    result = result.split(secret).join(MASK);
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactValue(
  value: unknown,
  secrets: string[],
  seen: WeakMap<object, unknown>
): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value, secrets);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) {
      result.push(redactValue(item, secrets, seen));
    }
    return result;
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [key, entry] of Object.entries(value)) {
      result[redactSecrets(key, secrets)] = redactValue(entry, secrets, seen);
    }
    return result;
  }

  // Dates, Maps, class instances, etc. are returned as-is; AgentEvent payloads
  // are expected to be JSON-like plain data.
  return value;
}

/**
 * Deep-copy `value`, redacting string values and object keys.
 * Handles arrays, plain objects and cycles; does not mutate the input.
 */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  const normalized = normalizeSecrets(secrets);
  if (normalized.length === 0) return value;
  return redactValue(value, normalized, new WeakMap()) as T;
}
