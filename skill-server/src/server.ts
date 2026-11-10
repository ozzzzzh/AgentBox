import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  authenticate,
  hasRole,
  type AuthConfig,
  type AuthResult,
  type Role,
} from './auth';
import { SkillValidationError, parseSkillPackage } from './model';
import {
  SkillStore,
  type SkillStatus,
  type SkillSummary,
} from './store';
import { adminHtml } from './admin';

const MAX_BODY_BYTES = 1_500_000;

export interface SkillServerOptions {
  dataDir: string;
  auth: AuthConfig;
  /** Development only: auto-login the admin page with this token. */
  devAdminToken?: string;
}

export interface SkillServer {
  server: Server;
  store: SkillStore;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown
): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function requireAuth(
  req: IncomingMessage,
  auth: AuthConfig,
  role: Role
): AuthResult {
  const result = authenticate(req, auth);
  if (result === undefined) {
    throw new HttpError(401, 'UNAUTHORIZED', 'missing or invalid bearer token');
  }
  if (!hasRole(result.role, role)) {
    throw new HttpError(403, 'FORBIDDEN', `role ${result.role} cannot ${role}`);
  }
  return result;
}

function headerValue(
  req: IncomingMessage,
  name: string
): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function recordSummary(
  summaries: SkillSummary,
  record: { status: SkillStatus }
): SkillSummary {
  return { ...summaries, status: record.status };
}

function parsePath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));
}

function filterStatus(
  summaries: SkillSummary[],
  status: string | null
): SkillSummary[] {
  if (status === null || status === '' || status === 'approved') {
    return summaries.filter((item) => item.status === 'approved');
  }
  if (status === 'all') return summaries;
  return summaries.filter((item) => item.status === status);
}

export function createSkillServer(options: SkillServerOptions): SkillServer {
  const store = new SkillStore(options.dataDir);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      if (error instanceof SkillValidationError) {
        sendError(res, 400, 'INVALID_SKILL', error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 400, 'BAD_REQUEST', message);
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = parsePath(url.pathname);
    const method = req.method ?? 'GET';

    if (method === 'GET' && parts.length === 1 && parts[0] === 'healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && (parts.length === 0 || parts[0] === 'admin')) {
      if (parts.length === 0) {
        res.writeHead(302, { location: '/admin' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(adminHtml(options.devAdminToken));
      return;
    }
    if (parts[0] !== 'v1') {
      throw new HttpError(404, 'NOT_FOUND', 'not found');
    }

    if (method === 'GET' && parts[1] === 'me' && parts.length === 2) {
      const auth = requireAuth(req, options.auth, 'reader');
      sendJson(res, 200, { actor: auth.actor, role: auth.role });
      return;
    }

    if (method === 'GET' && parts[1] === 'groups' && parts.length === 2) {
      requireAuth(req, options.auth, 'reader');
      sendJson(res, 200, { groups: store.listGroups() });
      return;
    }

    if (method === 'GET' && parts[1] === 'client' && parts[2] === 'groups') {
      requireAuth(req, options.auth, 'reader');
      const clientId = headerValue(req, 'x-agentbox-client');
      sendJson(res, 200, { groups: store.clientGroups(clientId) });
      return;
    }

    if (
      method === 'POST' &&
      parts[1] === 'client' &&
      parts[2] === 'groups' &&
      parts[3] !== undefined &&
      parts[4] === 'request'
    ) {
      const auth = requireAuth(req, options.auth, 'reader');
      const clientId = headerValue(req, 'x-agentbox-client');
      if (clientId === undefined) {
        throw new HttpError(
          400,
          'CLIENT_REQUIRED',
          'x-agentbox-client header is required'
        );
      }
      const body = (await readBody(req)) as { name?: unknown } | undefined;
      const record = store.requestGroup(
        clientId,
        headerValue(req, 'x-agentbox-client-name') ??
          (typeof body?.name === 'string' ? body.name : ''),
        parts[3],
        auth.actor
      );
      sendJson(res, 200, record);
      return;
    }

    if (method === 'GET' && parts[1] === 'group-requests') {
      requireAuth(req, options.auth, 'admin');
      const status = url.searchParams.get('status') ?? 'pending';
      sendJson(res, 200, {
        requests: store.listGroupRequests(
          status === 'all' ? 'all' : status === 'approved' || status === 'rejected'
            ? status
            : 'pending'
        ),
      });
      return;
    }

    if (
      method === 'POST' &&
      parts[1] === 'group-requests' &&
      parts[2] !== undefined &&
      parts[3] !== undefined
    ) {
      const auth = requireAuth(req, options.auth, 'admin');
      const body = (await readBody(req)) as { action?: unknown } | undefined;
      const action = asString(body?.action);
      if (action !== 'approve' && action !== 'reject') {
        throw new HttpError(400, 'INVALID_ACTION', 'action must be approve or reject');
      }
      const record = store.decideGroup(
        parts[2],
        parts[3],
        action === 'approve' ? 'approved' : 'rejected',
        auth.actor
      );
      sendJson(res, 200, record);
      return;
    }

    if (
      parts[1] === 'groups' &&
      parts[2] !== undefined &&
      (method === 'PUT' || method === 'DELETE')
    ) {
      const auth = requireAuth(req, options.auth, 'admin');
      const id = parts[2];
      if (method === 'DELETE') {
        const removed = store.deleteGroup(id, auth.actor);
        if (!removed) {
          throw new HttpError(404, 'NOT_FOUND', 'group not found');
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      const body = (await readBody(req)) as
        | { name?: unknown; description?: unknown; skillIds?: unknown }
        | undefined;
      const name = asString(body?.name);
      if (name === undefined) {
        throw new HttpError(400, 'INVALID_GROUP', 'name is required');
      }
      const skillIds = Array.isArray(body?.skillIds)
        ? body.skillIds.filter(
            (item): item is string => typeof item === 'string' && item.trim() !== ''
          )
        : undefined;
      const group = store.upsertGroup(
        id,
        {
          name,
          description:
            typeof body?.description === 'string' ? body.description : undefined,
          ...(skillIds === undefined ? {} : { skillIds }),
        },
        auth.actor
      );
      sendJson(res, 200, group);
      return;
    }

    if (method === 'GET' && parts[1] === 'skills' && parts.length === 2) {
      requireAuth(req, options.auth, 'reader');
      const auth = authenticate(req, options.auth)!;
      const includeUnapproved = hasRole(auth.role, 'reviewer');
      const all = store.list(includeUnapproved);
      const status = url.searchParams.get('status');
      const clientId = headerValue(req, 'x-agentbox-client');
      const visible = hasRole(auth.role, 'reviewer')
        ? all
        : all.filter((item) => store.skillAccessible(clientId, item.id));
      sendJson(res, 200, { skills: filterStatus(visible, status) });
      return;
    }

    if (method === 'GET' && parts[1] === 'required' && parts.length === 2) {
      const auth = requireAuth(req, options.auth, 'reader');
      const clientId = headerValue(req, 'x-agentbox-client');
      const required = store.required(url.searchParams.get('target') ?? undefined);
      sendJson(res, 200, {
        skills: hasRole(auth.role, 'reviewer')
          ? required
          : required.filter((item) => store.skillAccessible(clientId, item.id)),
      });
      return;
    }

    if (method === 'GET' && parts[1] === 'audit' && parts.length === 2) {
      requireAuth(req, options.auth, 'admin');
      const limit = Number(url.searchParams.get('limit') ?? '200');
      sendJson(res, 200, {
        audit: store.readAudit(Number.isFinite(limit) ? limit : 200),
      });
      return;
    }

    if (method === 'POST' && parts[1] === 'skills' && parts.length === 2) {
      const auth = requireAuth(req, options.auth, 'author');
      const body = await readBody(req);
      if (typeof body !== 'object' || body === null) {
        throw new HttpError(400, 'INVALID_SKILL', 'package body is required');
      }
      const skill = parseSkillPackage(body);
      const record = store.upload(skill, auth.actor);
      sendJson(res, 201, {
        id: record.id,
        version: record.version,
        status: record.status,
        hash: record.hash,
      });
      return;
    }

    if (parts[1] === 'skills' && parts[2] !== undefined) {
      const id = parts[2];
      if (method === 'GET' && parts.length === 3) {
        const auth = requireAuth(req, options.auth, 'reader');
        const records = store.list(hasRole(auth.role, 'reviewer'));
        sendJson(res, 200, {
          id,
          versions: records
            .filter((item) => item.id === id)
            .map((item) => item),
        });
        return;
      }

      const version = parts[3];
      if (version === undefined) {
        throw new HttpError(404, 'NOT_FOUND', 'not found');
      }
      if (method === 'GET' && parts.length === 4) {
        const auth = requireAuth(req, options.auth, 'reader');
        const record = store.getRecord(id, version);
        if (record === undefined) {
          throw new HttpError(404, 'NOT_FOUND', 'skill version not found');
        }
        if (record.status !== 'approved' && !hasRole(auth.role, 'reviewer')) {
          throw new HttpError(404, 'NOT_FOUND', 'skill version not found');
        }
        const skill = store.readPackage(id, version);
        if (skill === undefined) {
          throw new HttpError(404, 'NOT_FOUND', 'package file missing');
        }
        sendJson(res, 200, skill);
        return;
      }

      if (parts.length === 5 && parts[4] === 'approve' && method === 'POST') {
        const auth = requireAuth(req, options.auth, 'reviewer');
        const record = store.getRecord(id, version);
        if (record === undefined) {
          throw new HttpError(404, 'NOT_FOUND', 'skill version not found');
        }
        if (record.submittedBy === auth.actor && auth.role !== 'admin') {
          throw new HttpError(403, 'SELF_REVIEW', 'uploader cannot approve own skill');
        }
        const body = (await readBody(req)) as { comment?: unknown } | undefined;
        const updated = store.approve(
          id,
          version,
          auth.actor,
          asString(body?.comment)
        );
        sendJson(res, 200, recordSummary(store.list(true).find((item) => item.id === id && item.version === version)!, updated));
        return;
      }

      if (parts.length === 5 && parts[4] === 'reject' && method === 'POST') {
        const auth = requireAuth(req, options.auth, 'reviewer');
        const body = (await readBody(req)) as { comment?: unknown } | undefined;
        const updated = store.reject(
          id,
          version,
          auth.actor,
          asString(body?.comment)
        );
        sendJson(res, 200, updated);
        return;
      }

      if (parts.length === 5 && parts[4] === 'revoke' && method === 'POST') {
        const auth = requireAuth(req, options.auth, 'admin');
        const updated = store.revoke(id, version, auth.actor);
        sendJson(res, 200, updated);
        return;
      }
    }

    if (parts[1] === 'skills' && parts[2] !== undefined && parts[3] === 'policy' && method === 'PUT') {
      const auth = requireAuth(req, options.auth, 'admin');
      const id = parts[2];
      const body = (await readBody(req)) as
        | {
            required?: unknown;
            enabled?: unknown;
            version?: unknown;
            target?: unknown;
          }
        | undefined;
      const version = asString(body?.version);
      if (version === undefined) {
        throw new HttpError(400, 'INVALID_POLICY', 'version is required');
      }
      const required = body?.required === true;
      const target = asString(body?.target) ?? 'all';
      const policy = store.setPolicy(
        id,
        {
          required,
          version,
          target,
          ...(typeof body?.enabled === 'boolean'
            ? { enabled: body.enabled }
            : {}),
        },
        auth.actor
      );
      sendJson(res, 200, policy);
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'not found');
  }

  return {
    server,
    store,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
