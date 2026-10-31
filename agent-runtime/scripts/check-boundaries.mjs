#!/usr/bin/env node
/**
 * Static boundary check for src/:
 *  - no `vscode` import (runtime must stay headless)
 *  - no `pluginVersion/` import (old P1 code is reference-only)
 *
 * This is intentionally a lightweight regex check, not a full parser.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

const rules = [
  {
    label: 'vscode import',
    pattern:
      /(?:from\s*['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)|import\s*\(\s*['"]vscode['"]\s*\)|import\s*['"]vscode['"])/,
  },
  {
    label: 'pluginVersion import',
    pattern:
      /(?:from\s*['"][^'"]*pluginVersion[^'"]*['"]|require\(\s*['"][^'"]*pluginVersion[^'"]*['"]\s*\)|import\s*\(\s*['"][^'"]*pluginVersion[^'"]*['"]\s*\))/,
  },
];

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
}

walk(srcRoot);

const violations = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const rule of rules) {
    const match = source.match(rule.pattern);
    if (match && match.index !== undefined) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push({
        file: relative(srcRoot, file).split(sep).join('/'),
        line,
        label: rule.label,
      });
    }
  }
}

if (violations.length > 0) {
  console.error('Boundary check failed:');
  for (const violation of violations) {
    console.error(`  src/${violation.file}:${violation.line}  ${violation.label}`);
  }
  process.exit(1);
}

console.log(`Boundary check passed (${files.length} files scanned).`);
