const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chunkDocument, canonicalizeText, contentHash } = require('../dist/chunk.js');

test('canonicalizes BOM and CRLF before hashing', () => {
  const input = '﻿# A\r\n\r\nline\r\n';
  assert.equal(canonicalizeText(input), '# A\n\nline\n');
  assert.equal(
    contentHash(canonicalizeText(input)),
    contentHash(canonicalizeText('# A\n\nline\n'))
  );
});

test('markdown chunks preserve heading paths and line ranges', () => {
  const content = [
    '# Root',
    '',
    'intro text',
    '',
    '## Setup',
    '',
    'setup body',
    '',
    '### Details',
    '',
    'details body',
    '',
    '## Usage',
    '',
    'usage body',
  ].join('\n');
  const result = chunkDocument({ path: 'docs/a.md', content });
  assert.equal(result.kind, 'markdown');
  assert.ok(result.chunks.length >= 3);
  const setup = result.chunks.find((chunk) => chunk.heading === 'Setup');
  assert.ok(setup);
  assert.equal(setup.headingPath, 'Root > Setup');
  assert.equal(setup.startLine, 5);
  assert.equal(setup.endLine, 7);
  const details = result.chunks.find((chunk) => chunk.heading === 'Details');
  assert.ok(details);
  assert.equal(details.headingPath, 'Root > Setup > Details');
});

test('markdown does not treat headings inside fences as sections', () => {
  const content = [
    '# Root',
    '',
    '```ts',
    '# not a heading',
    'const value = 1;',
    '```',
    '',
    '## Real',
    '',
    'body',
  ].join('\n');
  const result = chunkDocument({ path: 'docs/a.md', content });
  assert.equal(result.chunks.length, 2);
  assert.equal(result.chunks[0].heading, 'Root');
  assert.equal(result.chunks[1].heading, 'Real');
});

test('sql splits on top-level semicolons only', () => {
  const content = [
    "CREATE TABLE t (name TEXT DEFAULT 'a;b');",
    '',
    '-- a comment with ;',
    "INSERT INTO t VALUES ('x;y');",
    '',
    'SELECT * FROM t;',
  ].join('\n');
  const result = chunkDocument({ path: 'db/schema.sql', content });
  assert.equal(result.kind, 'sql');
  assert.equal(result.chunks.length, 1);
  assert.match(result.chunks[0].text, /CREATE TABLE/);
  assert.match(result.chunks[0].text, /SELECT \* FROM t/);
});

test('code chunks report source line numbers', () => {
  const content = [
    'export function first() {',
    '  return 1;',
    '}',
    '',
    'export function second() {',
    '  return 2;',
    '}',
  ].join('\n');
  const result = chunkDocument({ path: 'src/a.ts', content });
  assert.equal(result.kind, 'code');
  assert.equal(result.chunks[0].startLine, 1);
  assert.equal(result.chunks[0].endLine, 7);
});
