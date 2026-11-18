export interface RedactResult {
  text: string;
  count: number;
}

interface Pattern {
  regex: RegExp;
  replace: string;
}

const PATTERNS: Pattern[] = [
  {
    regex: /\b(api[_-]?key|secret|password|passwd|token|authorization)\b\s*[:=]\s*["']?[^\s"',;]{4,}/gi,
    replace: '$1=[REDACTED]',
  },
  {
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: 'Bearer [REDACTED]',
  },
  {
    regex: /\bsk-[A-Za-z0-9_-]{8,}/g,
    replace: 'sk-[REDACTED]',
  },
  {
    regex: /\b(?:postgres|postgresql|mysql|mongodb|redis|mssql)::?\/\/[^\s"']+/gi,
    replace: '[REDACTED_CONNECTION]',
  },
  {
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED_PRIVATE_KEY]',
  },
  {
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: '[REDACTED_AWS_KEY]',
  },
];

export function redactText(input: string): RedactResult {
  let text = input;
  let count = 0;
  for (const pattern of PATTERNS) {
    const matches = text.match(pattern.regex);
    if (matches === null) continue;
    count += matches.length;
    text = text.replace(pattern.regex, pattern.replace);
  }
  return { text, count };
}

const SECRET_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_rsa.*|credentials.*|secrets.*)$/i;

export function isSecretPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return SECRET_FILE.test(name);
}
