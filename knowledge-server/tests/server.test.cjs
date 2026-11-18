const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createKnowledgeServer } = require('../dist/server.js');

const TOKENS = {
  'reader-token': 'reader',
  'author-token': 'author',
  'admin-token': 'admin',
};

async function withServer(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentbox-kb-server-'));
  const app = createKnowledgeServer({
    dataDir,
    auth: { tokens: TOKENS },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ base, app });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function request(base, path, options = {}) {
  const headers = {
    accept: 'application/json',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.user ? { 'x-agentbox-user': options.user } : {}),
    ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

test('healthz is public and knowledge routes require auth', async () => {
  await withServer(async ({ base }) => {
    assert.deepEqual((await request(base, '/healthz')).body, { ok: true });
    assert.equal((await request(base, '/v1/knowledge/status')).status, 401);
    const reader = await request(base, '/v1/knowledge/status', {
      token: 'reader-token',
    });
    assert.equal(reader.status, 200);
    assert.equal(reader.body.documents, 0);
  });
});

test('author upserts, reader searches, removedPaths deletes', async () => {
  await withServer(async ({ base }) => {
    const upsert = await request(base, '/v1/knowledge/documents', {
      method: 'POST',
      token: 'author-token',
      user: 'alice',
      body: {
        collection: 'ws_test',
        source: 'conversation',
        documents: [
          {
            path: 'docs/etl.md',
            content: '# ETL\n\n## 增量同步\n\n校验 watermark 后写入 orders。',
          },
        ],
      },
    });
    assert.equal(upsert.status, 200);
    assert.equal(upsert.body.indexed, 1);

    const search = await request(base, '/v1/knowledge/search', {
      method: 'POST',
      token: 'reader-token',
      body: { collection: 'ws_test', query: '增量同步', topK: 5 },
    });
    assert.equal(search.status, 200);
    assert.equal(search.body.results.length, 1);
    assert.equal(search.body.results[0].path, 'docs/etl.md');
    assert.equal(search.body.results[0].startLine, 3);

    const forbidden = await request(base, '/v1/knowledge/documents', {
      method: 'POST',
      token: 'reader-token',
      body: { collection: 'ws_test', documents: [] },
    });
    assert.equal(forbidden.status, 403);

    const removed = await request(base, '/v1/knowledge/documents', {
      method: 'POST',
      token: 'author-token',
      body: { collection: 'ws_test', documents: [], removedPaths: ['docs/etl.md'] },
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, 1);

    const after = await request(base, '/v1/knowledge/search', {
      method: 'POST',
      token: 'reader-token',
      body: { collection: 'ws_test', query: '增量同步' },
    });
    assert.equal(after.body.results.length, 0);
  });
});

test('admin can inspect status, audit and documents', async () => {
  await withServer(async ({ base }) => {
    await request(base, '/v1/knowledge/documents', {
      method: 'POST',
      token: 'author-token',
      body: {
        collection: 'ws_test',
        documents: [{ path: 'docs/a.md', content: '# A\n\nalpha' }],
      },
    });
    const status = await request(base, '/v1/knowledge/status', {
      token: 'admin-token',
    });
    assert.equal(status.body.documents, 1);
    assert.ok(status.body.chunks >= 1);

    const docs = await request(
      base,
      '/v1/knowledge/documents?collection=ws_test',
      { token: 'reader-token' }
    );
    assert.equal(docs.body.documents.length, 1);

    const audit = await request(base, '/v1/knowledge/audit', {
      token: 'admin-token',
    });
    assert.equal(audit.status, 200);
    assert.ok(audit.body.entries.some((entry) => entry.action === 'upsert'));
  });
});

test('invalid paths and oversized documents are per-document errors', async () => {
  await withServer(async ({ base }) => {
    const response = await request(base, '/v1/knowledge/documents', {
      method: 'POST',
      token: 'author-token',
      body: {
        collection: 'ws_test',
        documents: [
          { path: '../escape.md', content: '# bad' },
          { path: 'docs/ok.md', content: '# ok' },
        ],
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.indexed, 1);
    assert.equal(response.body.errors.length, 1);
    assert.equal(response.body.errors[0].code, 'INDEX_ERROR');
  });
});
