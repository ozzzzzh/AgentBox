/**
 * Seed the local Skill Registry with sample packages.
 *
 * Requires a running server:
 *   npm run dev
 *   # then, in another terminal:
 *   npm run seed
 *
 * Defaults match scripts/dev.cjs. Override with:
 *   SKILL_SERVER_URL, SKILL_SERVER_ADMIN_TOKEN
 */
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative, resolve, sep } = require('node:path');
const {
  parseSkillManifest,
  normalizeSkillFiles,
  computeSkillHash,
} = require('../dist/model.js');

const root = resolve(__dirname, '..', 'skills');
const base = (process.env.SKILL_SERVER_URL || 'http://127.0.0.1:4770').replace(/\/+$/, '');

function resolveToken() {
  if (process.env.SKILL_SERVER_ADMIN_TOKEN) {
    return process.env.SKILL_SERVER_ADMIN_TOKEN;
  }
  // Convenience for manual mode: reuse the token map from the server shell.
  if (process.env.SKILL_SERVER_TOKENS) {
    try {
      const tokens = JSON.parse(process.env.SKILL_SERVER_TOKENS);
      for (const [value, role] of Object.entries(tokens)) {
        if (role === 'admin') return value;
      }
    } catch {
      // fall through to the dev default
    }
  }
  return 'dev-admin';
}

const token = resolveToken();

const seeds = [
  { dir: 'team-encoding', approve: true, required: true, enabled: true },
  { dir: 'sql-etl', approve: true, required: false, enabled: true },
  { dir: 'frontend-style', approve: false },
  { dir: 'security-checklist', approve: true, required: false, enabled: false },
  { dir: 'general-style', approve: true, required: false, enabled: true },
];

function readFiles(dir) {
  const files = {};
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        const path = relative(dir, full).split(sep).join('/');
        if (path !== 'skill.json') files[path] = readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir);
  return normalizeSkillFiles(files);
}

function packageFrom(dirName) {
  const dir = join(root, dirName);
  const manifest = parseSkillManifest(
    JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf8'))
  );
  const files = readFiles(dir);
  return { manifest, files, hash: computeSkillHash(manifest, files) };
}

async function api(path, method, body) {
  const response = await fetch(base + path, {
    method: method || 'GET',
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : undefined; } catch { value = text; }
  return { status: response.status, value };
}

async function main() {
  console.log('Seeding ' + base);
  const me = await api('/v1/me');
  if (me.status === 401) {
    console.error('');
    console.error('Skill Server rejected the token.');
    console.error('  token: ' + token);
    console.error('');
    console.error('If the server was started with npm run dev, the token is dev-admin.');
    console.error('If it was started with SKILL_SERVER_TOKENS, use the admin key:');
    console.error('  PowerShell: $env:SKILL_SERVER_ADMIN_TOKEN="my-admin"; npm run seed');
    console.error('  or run seed in the same shell where SKILL_SERVER_TOKENS is set.');
    process.exit(1);
  }
  if (me.status !== 200) {
    throw new Error('cannot read /v1/me: ' + JSON.stringify(me.value));
  }
  console.log('  actor   ' + (me.value.actor || '') + ' (' + (me.value.role || '') + ')');
  for (const seed of seeds) {
    const pkg = packageFrom(seed.dir);
    const id = pkg.manifest.id;
    const version = pkg.manifest.version;

    const upload = await api('/v1/skills', 'POST', pkg);
    if (upload.status === 201) {
      console.log('  upload  ' + id + '@' + version);
    } else if (upload.status === 400 && /already exists/i.test(String(upload.value?.error?.message ?? ''))) {
      console.log('  exists  ' + id + '@' + version);
    } else {
      throw new Error('upload ' + id + '@' + version + ': ' + JSON.stringify(upload.value));
    }

    if (seed.approve) {
      const approved = await api(
        '/v1/skills/' + encodeURIComponent(id) + '/' + encodeURIComponent(version) + '/approve',
        'POST',
        { comment: 'seed data' }
      );
      if (approved.status !== 200 && !/already|approved|pending/i.test(String(approved.value?.error?.message ?? ''))) {
        throw new Error('approve ' + id + ': ' + JSON.stringify(approved.value));
      }
      console.log('  approve ' + id + '@' + version);
    }

    if (seed.approve) {
      const policy = await api('/v1/skills/' + encodeURIComponent(id) + '/policy', 'PUT', {
        required: seed.required === true,
        enabled: seed.enabled !== false,
        version,
        target: 'all',
      });
      if (policy.status !== 200) {
        throw new Error('policy ' + id + ': ' + JSON.stringify(policy.value));
      }
      console.log(
        '  policy  ' + id + ' required=' + (seed.required === true) +
        ' enabled=' + (seed.enabled !== false)
      );
    }
  }
  const groups = [
    { id: 'backend', name: 'Backend', description: 'Backend and data skills', skillIds: ['team-encoding', 'sql-etl'] },
    { id: 'security', name: 'Security', description: 'Security baseline', skillIds: ['security-checklist'] },
    { id: 'frontend', name: 'Frontend', description: 'Frontend conventions', skillIds: ['frontend-style'] },
  ];
  for (const group of groups) {
    const result = await api('/v1/groups/' + encodeURIComponent(group.id), 'PUT', group);
    if (result.status !== 200) throw new Error('group ' + group.id + ': ' + JSON.stringify(result.value));
    console.log('  group   ' + group.id);
  }
  console.log('Done.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
