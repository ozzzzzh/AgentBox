import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type Role = 'reader' | 'author' | 'admin';

const RANK: Record<Role, number> = {
  reader: 1,
  author: 2,
  admin: 3,
};

export interface AuthResult {
  actor: string;
  role: Role;
}

export interface AuthConfig {
  /** token -> role */
  tokens: Record<string, Role>;
  /** Development only: no token means reader. Must be loopback-only. */
  allowAnonymousReader?: boolean;
}

function isRole(value: unknown): value is Role {
  return value === 'reader' || value === 'author' || value === 'admin';
}

export function parseTokens(value: string | undefined): Record<string, Role> {
  if (value === undefined || value.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      'KNOWLEDGE_SERVER_TOKENS must be a JSON object of token -> role'
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'KNOWLEDGE_SERVER_TOKENS must be a JSON object of token -> role'
    );
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

function tokenActor(token: string): string {
  return `token#${createHash('sha256').update(token).digest('hex').slice(0, 8)}`;
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
  const headerUser = req.headers['x-agentbox-user'];
  const actor =
    typeof headerUser === 'string' && headerUser.trim() !== ''
      ? headerUser.trim()
      : tokenActor(token);
  return { actor, role };
}

export function hasRole(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

export function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return (
    value === '127.0.0.1' ||
    value === 'localhost' ||
    value === '::1' ||
    value === '[::1]'
  );
}
