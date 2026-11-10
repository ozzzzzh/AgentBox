const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  parseSkillManifest,
  normalizeSkillFiles,
  computeSkillHash,
} = require('../dist/model.js');
const { createSkillServer } = require('../dist/server.js');

const TOKENS = {
  'reader-token': 'reader',
  'author-token': 'author',
  'reviewer-token': 'reviewer',
  'admin-token': 'admin',
};

function packageJson(id = 'team-encoding', version = '1.0.0') {
  const manifest = parseSkillManifest({
    schemaVersion: 1,
    id,
    name: 'Team encoding',
    version,
    description: 'encoding rules',
    owner: 'platform',
    activation: 'always',
    priority: 100,
    budget: { maxChars: 2000 },
    required: false,
  });
  const files = normalizeSkillFiles({
    'SKILL.md': '# Team encoding\n\n- use strict\n',
    'references/naming.md': '# naming\n',
  });
  return { manifest, files, hash: computeSkillHash(manifest, files) };
}

async function withServer(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentbox-skill-server-'));
  const app = createSkillServer({
    dataDir,
    auth: { tokens: TOKENS },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ base, app });
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
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
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

test('healthz is public', async () => {
  await withServer(async ({ base }) => {
    const response = await request(base, '/healthz');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
  });
});

test('upload is pending until a reviewer approves it', async () => {
  await withServer(async ({ base }) => {
    const pkg = packageJson();

    const unauthorized = await request(base, '/v1/skills', {
      method: 'POST',
      body: pkg,
    });
    assert.equal(unauthorized.status, 401);

    const upload = await request(base, '/v1/skills', {
      method: 'POST',
      token: 'author-token',
      user: 'alice',
      body: pkg,
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.body.status, 'pending');

    const readerList = await request(base, '/v1/skills', {
      token: 'reader-token',
    });
    assert.equal(readerList.status, 200);
    assert.equal(readerList.body.skills.length, 0);

    const pending = await request(base, '/v1/skills?status=pending', {
      token: 'reviewer-token',
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.skills.length, 1);
    assert.equal(pending.body.skills[0].id, 'team-encoding');

    const before = await request(
      base,
      '/v1/skills/team-encoding/1.0.0',
      { token: 'reader-token' }
    );
    assert.equal(before.status, 404);

    const reviewed = await request(
      base,
      '/v1/skills/team-encoding/1.0.0/approve',
      {
        method: 'POST',
        token: 'reviewer-token',
        user: 'bob',
        body: { comment: 'looks good' },
      }
    );
    assert.equal(reviewed.status, 200);

    const after = await request(
      base,
      '/v1/skills/team-encoding/1.0.0',
      { token: 'reader-token' }
    );
    assert.equal(after.status, 200);
    assert.equal(after.body.hash, pkg.hash);
    assert.equal(after.body.files['SKILL.md'], pkg.files['SKILL.md']);

    const approved = await request(base, '/v1/skills?status=approved', {
      token: 'reader-token',
    });
    assert.equal(approved.body.skills.length, 1);
    assert.equal(approved.body.skills[0].status, 'approved');
  });
});

test('required policy controls /v1/required and cannot point at pending', async () => {
  await withServer(async ({ base }) => {
    const pkg = packageJson('team-format', '1.0.0');
    await request(base, '/v1/skills', {
      method: 'POST',
      token: 'author-token',
      user: 'alice',
      body: pkg,
    });

    const pendingPolicy = await request(
      base,
      '/v1/skills/team-format/policy',
      {
        method: 'PUT',
        token: 'admin-token',
        body: { required: true, version: '1.0.0', target: 'all' },
      }
    );
    assert.equal(pendingPolicy.status, 400);

    await request(base, '/v1/skills/team-format/1.0.0/approve', {
      method: 'POST',
      token: 'reviewer-token',
      user: 'bob',
    });

    const policy = await request(base, '/v1/skills/team-format/policy', {
      method: 'PUT',
      token: 'admin-token',
      body: { required: true, version: '1.0.0', target: 'all' },
    });
    assert.equal(policy.status, 200);
    assert.equal(policy.body.required, true);

    const required = await request(base, '/v1/required', {
      token: 'reader-token',
    });
    assert.equal(required.status, 200);
    assert.equal(required.body.skills.length, 1);
    assert.equal(required.body.skills[0].required, true);
  });
});

test('reviewer cannot approve their own upload', async () => {
  await withServer(async ({ base }) => {
    const pkg = packageJson('self-review', '1.0.0');
    await request(base, '/v1/skills', {
      method: 'POST',
      token: 'author-token',
      user: 'same-user',
      body: pkg,
    });

    const self = await request(
      base,
      '/v1/skills/self-review/1.0.0/approve',
      {
        method: 'POST',
        token: 'reviewer-token',
        user: 'same-user',
      }
    );
    assert.equal(self.status, 403);

    const admin = await request(
      base,
      '/v1/skills/self-review/1.0.0/approve',
      {
        method: 'POST',
        token: 'admin-token',
        user: 'same-user',
      }
    );
    assert.equal(admin.status, 200);
  });
});

test('reject and revoke update visibility', async () => {
  await withServer(async ({ base }) => {
    const pkg = packageJson('team-errors', '1.0.0');
    await request(base, '/v1/skills', {
      method: 'POST',
      token: 'author-token',
      user: 'alice',
      body: pkg,
    });
    await request(base, '/v1/skills/team-errors/1.0.0/reject', {
      method: 'POST',
      token: 'reviewer-token',
      user: 'bob',
      body: { comment: 'needs examples' },
    });

    const visible = await request(
      base,
      '/v1/skills/team-errors/1.0.0',
      { token: 'reader-token' }
    );
    assert.equal(visible.status, 404);

    const pkg2 = packageJson('team-errors', '1.0.1');
    await request(base, '/v1/skills', {
      method: 'POST',
      token: 'author-token',
      user: 'alice',
      body: pkg2,
    });
    await request(base, '/v1/skills/team-errors/1.0.1/approve', {
      method: 'POST',
      token: 'reviewer-token',
      user: 'bob',
    });
    await request(base, '/v1/skills/team-errors/policy', {
      method: 'PUT',
      token: 'admin-token',
      body: { required: true, version: '1.0.1', target: 'all' },
    });
    const revoke = await request(
      base,
      '/v1/skills/team-errors/1.0.1/revoke',
      { method: 'POST', token: 'admin-token' }
    );
    assert.equal(revoke.status, 200);

    const required = await request(base, '/v1/required', {
      token: 'reader-token',
    });
    assert.equal(required.body.skills.length, 0);
  });
});

test('me reports the token role and admin page is served', async () => {
  await withServer(async ({ base }) => {
    const me = await request(base, '/v1/me', { token: 'admin-token', user: 'alice' });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { actor: 'alice', role: 'admin' });

    const page = await request(base, '/admin');
    assert.equal(page.status, 200);
    assert.equal(typeof page.body, 'string');
    assert.match(page.body, /Skill Registry/);
    assert.match(page.body, /登录/);
  });
});

test('enabled policy excludes a version from agents while keeping it visible to admins', async () => {
  await withServer(async ({ base }) => {
    const pkg = packageJson('team-hidden', '1.0.0');
    await request(base, '/v1/skills', {
      method: 'POST',
      token: 'author-token',
      user: 'alice',
      body: pkg,
    });
    await request(base, '/v1/skills/team-hidden/1.0.0/approve', {
      method: 'POST',
      token: 'reviewer-token',
      user: 'bob',
    });

    const hidden = await request(base, '/v1/skills/team-hidden/policy', {
      method: 'PUT',
      token: 'admin-token',
      body: { required: true, enabled: false, version: '1.0.0', target: 'all' },
    });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.enabled, false);
    assert.equal(hidden.body.required, false);

    const approved = await request(base, '/v1/skills?status=approved', {
      token: 'reader-token',
    });
    const item = approved.body.skills.find((skill) => skill.id === 'team-hidden');
    assert.equal(item.enabled, false);
    assert.equal(item.required, false);

    const required = await request(base, '/v1/required', { token: 'reader-token' });
    assert.equal(required.body.skills.length, 0);

    await request(base, '/v1/skills/team-hidden/policy', {
      method: 'PUT',
      token: 'admin-token',
      body: { required: true, enabled: true, version: '1.0.0', target: 'all' },
    });
    const after = await request(base, '/v1/required', { token: 'reader-token' });
    assert.equal(after.body.skills.length, 1);
    assert.equal(after.body.skills[0].enabled, true);
  });
});

test('groups can be managed and appear on skill summaries', async () => {
  await withServer(async ({ base }) => {
    const pkg = packageJson('grouped-skill', '1.0.0');
    await request(base, '/v1/skills', {
      method: 'POST',
      token: 'author-token',
      user: 'alice',
      body: pkg,
    });
    await request(base, '/v1/skills/grouped-skill/1.0.0/approve', {
      method: 'POST',
      token: 'reviewer-token',
      user: 'bob',
    });

    const created = await request(base, '/v1/groups/backend', {
      method: 'PUT',
      token: 'admin-token',
      body: {
        name: 'Backend',
        description: 'server-side skills',
        skillIds: ['grouped-skill'],
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.name, 'Backend');

    const groups = await request(base, '/v1/groups', { token: 'reader-token' });
    assert.equal(groups.status, 200);
    assert.equal(groups.body.groups.length, 1);

    const approved = await request(base, '/v1/skills?status=approved', {
      token: 'reviewer-token',
    });
    const item = approved.body.skills.find((skill) => skill.id === 'grouped-skill');
    assert.deepEqual(item.groups, ['Backend']);

    const updated = await request(base, '/v1/groups/backend', {
      method: 'PUT',
      token: 'admin-token',
      body: { name: 'Backend Platform', skillIds: [] },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Backend Platform');

    const removed = await request(base, '/v1/groups/backend', {
      method: 'DELETE',
      token: 'admin-token',
    });
    assert.equal(removed.status, 200);
    const empty = await request(base, '/v1/groups', { token: 'reader-token' });
    assert.deepEqual(empty.body.groups, []);
  });
});

test('group membership gates grouped skills for a client', async () => {
  await withServer(async ({ base }) => {
    const pkg = packageJson('gated-skill', '1.0.0');
    await request(base, '/v1/skills', {
      method: 'POST',
      token: 'author-token',
      user: 'alice',
      body: pkg,
    });
    await request(base, '/v1/skills/gated-skill/1.0.0/approve', {
      method: 'POST',
      token: 'reviewer-token',
      user: 'bob',
    });
    await request(base, '/v1/skills/gated-skill/policy', {
      method: 'PUT',
      token: 'admin-token',
      body: { required: true, enabled: true, version: '1.0.0', target: 'all' },
    });
    await request(base, '/v1/groups/backend', {
      method: 'PUT',
      token: 'admin-token',
      body: { name: 'Backend', skillIds: ['gated-skill'] },
    });

    const clientHeaders = { 'x-agentbox-client': 'client-test' };
    const before = await request(base, '/v1/skills?status=approved', {
      token: 'reader-token',
      headers: clientHeaders,
    });
    assert.equal(before.body.skills.length, 0);

    const requested = await request(base, '/v1/client/groups/backend/request', {
      method: 'POST',
      token: 'reader-token',
      headers: clientHeaders,
      body: { name: 'test workspace' },
    });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.status, 'pending');

    const pending = await request(base, '/v1/skills?status=approved', {
      token: 'reader-token',
      headers: clientHeaders,
    });
    assert.equal(pending.body.skills.length, 0);

    const requests = await request(base, '/v1/group-requests', {
      token: 'admin-token',
    });
    assert.equal(requests.body.requests.length, 1);
    assert.equal(requests.body.requests[0].clientId, 'client-test');

    const approved = await request(
      base,
      '/v1/group-requests/client-test/backend',
      {
        method: 'POST',
        token: 'admin-token',
        body: { action: 'approve' },
      }
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'approved');

    const after = await request(base, '/v1/skills?status=approved', {
      token: 'reader-token',
      headers: clientHeaders,
    });
    assert.equal(after.body.skills.length, 1);
    assert.equal(after.body.skills[0].id, 'gated-skill');
    assert.equal(after.body.skills[0].required, true);

    const required = await request(base, '/v1/required', {
      token: 'reader-token',
      headers: clientHeaders,
    });
    assert.equal(required.body.skills.length, 1);
  });
});
