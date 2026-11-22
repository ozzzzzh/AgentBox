import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexCandidates, locateCodex } from '../src/codex-locator';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentbox-codex-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('codex locator', () => {
  it('finds codex on PATH', () => {
    const dir = tempDir();
    const name = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    writeFileSync(join(dir, name), '#!/bin/sh\n', 'utf8');
    const found = locateCodex({
      platform: process.platform,
      env: { PATH: dir },
      home: dir,
    });
    expect(found).toBe(join(dir, name));
  });

  it('includes platform-specific common paths', () => {
    const mac = codexCandidates('darwin', { PATH: '' }, '/Users/test');
    expect(mac).toContain('/opt/homebrew/bin/codex');
    expect(mac).toContain('/usr/local/bin/codex');
    const win = codexCandidates(
      'win32',
      { PATH: 'C:\\bin', APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      'C:\\Users\\test'
    );
    expect(win.some((path) => path.endsWith('codex.cmd'))).toBe(true);
  });
});
