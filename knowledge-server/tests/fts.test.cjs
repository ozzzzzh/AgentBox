const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { KnowledgeStore } = require('../dist/store.js');

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-kb-store-'));
  const store = new KnowledgeStore(dir);
  try {
    return fn({ store, dir });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function upsert(store, documents, extra = {}) {
  return store.upsert(
    {
      collection: 'ws_test',
      documents,
      ...extra,
    },
    'tester'
  );
}

test('upsert and search return citation metadata', () => {
  withStore(({ store }) => {
    const response = upsert(store, [
      {
        path: 'docs/etl/intern_test.md',
        content: [
          '# intern_test ETL',
          '',
          '## 3.2 增量同步',
          '',
          '增量同步逻辑：先校验 watermark，再批量写入 orders 表。',
        ].join('\n'),
      },
    ]);
    assert.equal(response.indexed, 1);
    assert.equal(response.errors.length, 0);

    const search = store.search(
      { collection: 'ws_test', query: '增量同步', topK: 5 },
      'tester'
    );
    assert.equal(search.mode, 'fts');
    assert.ok(search.results.length >= 1);
    const hit = search.results[0];
    assert.equal(hit.path, 'docs/etl/intern_test.md');
    assert.equal(hit.heading, '3.2 增量同步');
    assert.equal(hit.startLine, 3);
    assert.equal(hit.endLine, 5);
    assert.match(hit.snippet, /增量同步/);
    assert.ok(hit.score >= 0);
    assert.ok(hit.text.includes('watermark'));
  });
});

test('short CJK query falls back to instr', () => {
  withStore(({ store }) => {
    upsert(store, [
      {
        path: 'docs/orders.md',
        content: '# Orders\n\n订单增量同步需要校验 watermark。',
      },
    ]);
    const search = store.search(
      { collection: 'ws_test', query: '订单', topK: 5 },
      'tester'
    );
    assert.equal(search.mode, 'instr');
    assert.equal(search.results.length, 1);
    assert.match(search.results[0].text, /订单/);
  });
});

test('unchanged content is skipped unless forced', () => {
  withStore(({ store }) => {
    const doc = { path: 'docs/a.md', content: '# A\n\nalpha token' };
    assert.equal(upsert(store, [doc]).indexed, 1);
    assert.equal(upsert(store, [doc]).unchanged, 1);
    const forced = upsert(store, [{ ...doc, content: '# A\n\nbeta token' }], {
      force: true,
    });
    assert.equal(forced.indexed, 1);
    assert.equal(
      store.search({ collection: 'ws_test', query: 'alpha' }, 'tester').results.length,
      0
    );
    assert.equal(
      store.search({ collection: 'ws_test', query: 'beta' }, 'tester').results.length,
      1
    );
  });
});

test('removedPaths and delete remove FTS rows', () => {
  withStore(({ store }) => {
    upsert(store, [
      { path: 'docs/a.md', content: '# A\n\nunique_alpha' },
      { path: 'docs/b.md', content: '# B\n\nunique_beta' },
    ]);
    const removed = upsert(store, [], { removedPaths: ['docs/a.md'] });
    assert.equal(removed.removed, 1);
    assert.equal(
      store.search({ collection: 'ws_test', query: 'unique_alpha' }, 'tester').results.length,
      0
    );
    assert.equal(
      store.search({ collection: 'ws_test', query: 'unique_beta' }, 'tester').results.length,
      1
    );
  });
});

test('FTS survives VACUUM after rowid reuse', () => {
  withStore(({ store }) => {
    upsert(store, [
      { path: 'docs/a.md', content: '# A\n\nfirst_marker' },
      { path: 'docs/b.md', content: '# B\n\nsecond_marker' },
    ]);
    upsert(store, [], { removedPaths: ['docs/a.md'] });
    upsert(store, [{ path: 'docs/c.md', content: '# C\n\nthird_marker' }]);
    store.maintenance('vacuum');
    assert.equal(
      store.search({ collection: 'ws_test', query: 'first_marker' }, 'tester').results.length,
      0
    );
    assert.equal(
      store.search({ collection: 'ws_test', query: 'third_marker' }, 'tester').results.length,
      1
    );
  });
});

test('collection and path filters are isolated', () => {
  withStore(({ store }) => {
    store.upsert(
      {
        collection: 'ws_a',
        documents: [{ path: 'docs/a.md', content: '# A\n\nshared_marker' }],
      },
      'tester'
    );
    store.upsert(
      {
        collection: 'ws_b',
        documents: [{ path: 'src/b.ts', content: '// B\n\nshared_marker' }],
      },
      'tester'
    );
    const a = store.search(
      { collection: 'ws_a', query: 'shared_marker' },
      'tester'
    );
    assert.equal(a.results.length, 1);
    assert.equal(a.results[0].path, 'docs/a.md');
    const prefixed = store.search(
      {
        collection: 'ws_b',
        query: 'shared_marker',
        filters: { pathPrefix: 'docs' },
      },
      'tester'
    );
    assert.equal(prefixed.results.length, 0);
  });
});

test('redacts high-confidence secrets and skips secret documents', () => {
  withStore(({ store }) => {
    const response = upsert(store, [
      {
        path: 'docs/config.md',
        content: '# Config\n\napi_key = "sk-1234567890abcdef"\n',
      },
      {
        path: '.env',
        content: 'TOKEN=super-secret',
      },
      {
        path: 'docs/secret.md',
        content: '# secret',
        sensitivity: 'secret',
      },
    ]);
    assert.equal(response.indexed, 1);
    assert.ok(response.redactions >= 1);
    assert.equal(
      store.search({ collection: 'ws_test', query: 'sk-1234567890abcdef' }, 'tester')
        .results.length,
      0
    );
    assert.equal(
      store.search({ collection: 'ws_test', query: 'super' }, 'tester').results.length,
      0
    );
    const redacted = store.search(
      { collection: 'ws_test', query: 'api_key' },
      'tester'
    );
    assert.equal(redacted.results.length, 1);
    assert.match(redacted.results[0].text, /api_key=\[REDACTED\]/);
    assert.doesNotMatch(redacted.results[0].text, /\$1/);
  });
});

test('marking an existing document secret removes its indexed copy', () => {
  withStore(({ store }) => {
    upsert(store, [
      {
        path: 'docs/config.md',
        content: '# Config\n\nsecret_marker',
      },
    ]);
    assert.equal(
      store.search({ collection: 'ws_test', query: 'secret_marker' }, 'tester')
        .results.length,
      1
    );
    const response = upsert(store, [
      {
        path: 'docs/config.md',
        content: '# Config\n\nsecret_marker',
        sensitivity: 'secret',
      },
    ]);
    assert.equal(response.skipped, 1);
    assert.equal(
      store.search({ collection: 'ws_test', query: 'secret_marker' }, 'tester')
        .results.length,
      0
    );
  });
});

test('reindex rebuilds FTS and integrity check passes', () => {
  withStore(({ store }) => {
    upsert(store, [
      { path: 'docs/a.md', content: '# A\n\nrebuild_marker' },
    ]);
    const reindexed = store.reindex();
    assert.equal(reindexed.documents, 1);
    assert.equal(
      store.search({ collection: 'ws_test', query: 'rebuild_marker' }, 'tester')
        .results.length,
      1
    );
    assert.equal(store.maintenance('integrity-check').detail, 'ok');
  });
});

test('status reports counts and persistence survives reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-kb-store-'));
  try {
    const first = new KnowledgeStore(dir);
    upsert(first, [{ path: 'docs/a.md', content: '# A\n\npersisted_marker' }]);
    assert.equal(first.status().documents, 1);
    assert.ok(first.status().chunks >= 1);
    first.close();

    const second = new KnowledgeStore(dir);
    const search = second.search(
      { collection: 'ws_test', query: 'persisted_marker' },
      'tester'
    );
    assert.equal(search.results.length, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
