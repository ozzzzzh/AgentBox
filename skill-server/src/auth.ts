import type { IncomingMessage } from 'node:http';

export type Role = 'reader' | 'author' | 'reviewer' | 'admin';

const RANK: Record<Role, number> = {
  reader: 1,
  author: 2,
  reviewer: 3,
  admin: 4,
};

export interface AuthResult {
  actor: string;
  role: Role;
}

export interface AuthConfig {
  /** token -> role */
  tokens: Record<string, Role>;
  /** Optional development mode: no token means reader. */
  allowAnonymousReader?: boolean;
}

function isRole(value: unknown): value is Role {
  return (
    value === 'reader' ||
    value === 'author' ||
    value === 'reviewer' ||
    value === 'admin'
  );
}

export function parseTokens(value: string | undefined): Record<string, Role> {
  if (value === undefined || value.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('SKILL_SERVER_TOKENS must be a JSON object of token -> role');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('SKILL_SERVER_TOKENS must be a JSON object of token -> role');
  }
  const tokens: Record<string, Role> = {};
  for (const [token, role] of Object.entries(parsed)) {
    if (!isRole(role)) {
      throw new Error(`invalid role for token ${token.slice(0, 4)}…`);
    }
    tokens[token] = role;
  }
  return tokens;
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

export function authenticate(
  req: IncomingMessage,
  config: AuthConfig
): AuthResult | undefined {
  const token = bearerToken(req);
  if (token === undefined || token === '') {
    if (config.allowAnonymousReader === true) {
      return { actor: 'anonymous', role: 'reader' };
    }
    return undefined;
  }
  const role = config.tokens[token];
  if (role === undefined) return undefined;
  const actor =
    typeof req.headers['x-agentbox-user'] === 'string' &&
    req.headers['x-agentbox-user'].trim() !== ''
      ? req.headers['x-agentbox-user'].trim()
      : `token:${token.slice(0, 8)}`;
  return { actor, role };
}

export function hasRole(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}
