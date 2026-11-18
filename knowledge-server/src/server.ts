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
import {
  KnowledgeError,
  LIMITS,
  isRecord,
  type SearchRequest,
  type UpsertDocumentsRequest,
} from './contract';
import { KnowledgeStore } from './store';

export interface KnowledgeServerOptions {
  dataDir: string;
  auth: AuthConfig;
}

export interface KnowledgeServer {
  server: Server;
  store: KnowledgeStore;
  close(): Promise<void>;
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
      if (total > LIMITS.maxBodyBytes) {
        reject(
          new KnowledgeError(413, 'PAYLOAD_TOO_LARGE', 'request body too large')
        );
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
        reject(new KnowledgeError(400, 'INVALID_JSON', 'request body is not JSON'));
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
    throw new KnowledgeError(401, 'UNAUTHORIZED', 'missing or invalid bearer token');
  }
  if (!hasRole(result.role, role)) {
    throw new KnowledgeError(403, 'FORBIDDEN', `role ${result.role} cannot ${role}`);
  }
  return result;
}

function parsePath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));
}

function asPositiveInt(value: string | null, fallback: number): number {
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function requireCollection(value: string | null): string {
  if (value === null || value.trim() === '') {
    throw new KnowledgeError(400, 'COLLECTION_REQUIRED', 'collection is required');
  }
  return value.trim();
}

export function createKnowledgeServer(
  options: KnowledgeServerOptions
): KnowledgeServer {
  const store = new KnowledgeStore(options.dataDir);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof KnowledgeError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 500, 'INTERNAL_ERROR', message);
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
    if (parts[0] !== 'v1') {
      throw new KnowledgeError(404, 'NOT_FOUND', 'not found');
    }

    if (method === 'GET' && parts[1] === 'me' && parts.length === 2) {
      const auth = requireAuth(req, options.auth, 'reader');
      sendJson(res, 200, { actor: auth.actor, role: auth.role });
      return;
    }

    if (parts[1] !== 'knowledge') {
      throw new KnowledgeError(404, 'NOT_FOUND', 'not found');
    }

    if (method === 'GET' && parts[2] === 'status' && parts.length === 3) {
      requireAuth(req, options.auth, 'reader');
      sendJson(res, 200, store.status());
      return;
    }

    if (method === 'GET' && parts[2] === 'collections' && parts.length === 3) {
      requireAuth(req, options.auth, 'reader');
      sendJson(res, 200, {
        apiVersion: 1,
        collections: store.status().collections,
      });
      return;
    }

    if (parts[2] === 'documents' && parts.length === 3) {
      if (method === 'GET') {
        requireAuth(req, options.auth, 'reader');
        const collection = requireCollection(url.searchParams.get('collection'));
        const limit = asPositiveInt(url.searchParams.get('limit'), 500);
        const offset = asPositiveInt(url.searchParams.get('offset'), 0);
        sendJson(res, 200, store.listDocuments(collection, limit, offset));
        return;
      }
      if (method === 'POST') {
        const auth = requireAuth(req, options.auth, 'author');
        const body = await readBody(req);
        if (!isRecord(body)) {
          throw new KnowledgeError(400, 'INVALID_BODY', 'body must be an object');
        }
        sendJson(
          res,
          200,
          store.upsert(body as unknown as UpsertDocumentsRequest, auth.actor)
        );
        return;
      }
    }

    if (parts[2] === 'documents' && parts.length === 4) {
      const id = parts[3]!;
      if (method === 'GET') {
        requireAuth(req, options.auth, 'reader');
        const includeChunks =
          url.searchParams.get('includeChunks') === '1' ||
          url.searchParams.get('includeChunks') === 'true';
        const document = store.getDocument(id, includeChunks);
        if (document === undefined) {
          throw new KnowledgeError(404, 'NOT_FOUND', 'document not found');
        }
        sendJson(res, 200, document);
        return;
      }
      if (method === 'DELETE') {
        const auth = requireAuth(req, options.auth, 'admin');
        const deleted = store.deleteDocument(id, auth.actor);
        if (!deleted) {
          throw new KnowledgeError(404, 'NOT_FOUND', 'document not found');
        }
        sendJson(res, 200, { ok: true, deleted: true });
        return;
      }
    }

    if (method === 'POST' && parts[2] === 'search' && parts.length === 3) {
      const auth = requireAuth(req, options.auth, 'reader');
      const body = await readBody(req);
      if (!isRecord(body)) {
        throw new KnowledgeError(400, 'INVALID_BODY', 'body must be an object');
      }
      sendJson(res, 200, store.search(body as unknown as SearchRequest, auth.actor));
      return;
    }

    if (method === 'POST' && parts[2] === 'reindex' && parts.length === 3) {
      requireAuth(req, options.auth, 'admin');
      sendJson(res, 200, store.reindex());
      return;
    }

    if (method === 'POST' && parts[2] === 'maintenance' && parts.length === 3) {
      requireAuth(req, options.auth, 'admin');
      const body = await readBody(req);
      if (!isRecord(body) || typeof body.action !== 'string') {
        throw new KnowledgeError(400, 'INVALID_BODY', 'action is required');
      }
      sendJson(res, 200, store.maintenance(body.action));
      return;
    }

    if (method === 'GET' && parts[2] === 'audit' && parts.length === 3) {
      requireAuth(req, options.auth, 'admin');
      const limit = asPositiveInt(url.searchParams.get('limit'), 100);
      const action = url.searchParams.get('action') ?? undefined;
      sendJson(res, 200, { apiVersion: 1, entries: store.listAudit(limit, action) });
      return;
    }

    throw new KnowledgeError(404, 'NOT_FOUND', 'not found');
  }

  return {
    server,
    store,
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (!server.listening) {
          store.close();
          resolve();
          return;
        }
        server.close(() => {
          store.close();
          resolve();
        });
      });
    },
  };
}
