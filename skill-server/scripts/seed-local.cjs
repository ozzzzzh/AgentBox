/**
 * Write the sample skills directly into the Skill Registry data directory.
 *
 * This does NOT need a running server and does NOT need a token. It is useful
 * for preparing a local test dataset before starting the server.
 *
 *   npm run seed:local
 *   npm run dev:seed     # seed + start the dev server
 *
 * If the server is already running, stop it first and restart it after seeding
 * so it reloads index.json / policies.json from disk.
 *
 * Data directory:
 *   SKILL_SERVER_DATA if set, otherwise .dev-data (same as npm run dev).
 */
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative, resolve, sep } = require('node:path');
const {
  parseSkillManifest,
  normalizeSkillFiles,
  computeSkillHash,
} = require('../dist/model.js');
const { SkillStore } = require('../dist/store.js');

const root = resolve(__dirname, '..', 'skills');
const dataDir = resolve(
  process.env.SKILL_SERVER_DATA || resolve(__dirname, '..', '.dev-data')
);

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

function ignore(error, pattern) {
  if (pattern.test(String(error && error.message ? error.message : error))) {
    return;
  }
  throw error;
}

const store = new SkillStore(dataDir);
console.log('Seeding data directory: ' + dataDir);

for (const seed of seeds) {
  const pkg = packageFrom(seed.dir);
  const id = pkg.manifest.id;
  const version = pkg.manifest.version;

  try {
    store.upload(pkg, 'seed');
    console.log('  upload  ' + id + '@' + version);
  } catch (error) {
    ignore(error, /already exists/i);
    console.log('  exists  ' + id + '@' + version);
  }

  if (seed.approve) {
    try {
      store.approve(id, version, 'seed', 'seed data');
      console.log('  approve ' + id + '@' + version);
    } catch (error) {
      ignore(error, /is approved/i);
      console.log('  approved ' + id + '@' + version);
    }

    store.setPolicy(
      id,
      {
        required: seed.required === true,
        enabled: seed.enabled !== false,
        version,
        target: 'all',
      },
      'seed'
    );
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
  store.upsertGroup(group.id, group, 'seed');
  console.log('  group   ' + group.id);
}

console.log('Done. Start/restart the server to load this data.');
