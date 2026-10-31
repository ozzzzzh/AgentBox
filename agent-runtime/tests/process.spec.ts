import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeError } from '../src/errors.js';
import {
  spawnManaged,
  type ExitInfo,
  type ManagedProcess,
  type SpawnOptions,
} from '../src/process.js';

const fixturePath = fileURLToPath(
  new URL('./fixtures/process/line-writer.cjs', import.meta.url)
);

let spawned: ManagedProcess[] = [];

function spawnFixture(
  mode: string,
  options: Partial<SpawnOptions> = {}
): ManagedProcess {
  const proc = spawnManaged({
    command: process.execPath,
    args: [fixturePath, mode],
    cwd: process.cwd(),
    ...options,
  });
  spawned.push(proc);
  return proc;
}

function collect(proc: ManagedProcess): {
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  proc.onStdoutLine((line) => stdout.push(line));
  proc.onStderrLine((line) => stderr.push(line));
  return { stdout, stderr };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function expectRuntimeError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as RuntimeError).name).toBe('RuntimeError');
    expect((error as RuntimeError).code).toBe(code);
    return;
  }
  throw new Error(`expected RuntimeError(${code}) but nothing was thrown`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

afterEach(async () => {
  await Promise.all(
    spawned.map((proc) => proc.kill().catch(() => undefined))
  );
  spawned = [];
});

describe('spawnManaged', () => {
  it('splits stdout into lines across chunks, CRLF and a final partial line', async () => {
    const proc = spawnFixture('lines');
    const { stdout } = collect(proc);

    const info = await proc.exited;

    expect(info.code).toBe(0);
    expect(info.signal).toBeNull();
    expect(stdout).toEqual(['alpha', 'beta', 'gamma', 'partial']);
    expect(proc.running).toBe(false);
  });

  it('captures stderr and a non-zero exit code', async () => {
    const proc = spawnFixture('exit');
    const { stderr } = collect(proc);

    const info = await proc.exited;

    expect(info.code).toBe(3);
    expect(stderr).toEqual(['oops']);
  });

  it('notifies onExit listeners with exit info', async () => {
    const proc = spawnFixture('exit');

    const info = await new Promise<ExitInfo>((resolve) => {
      proc.onExit(resolve);
    });

    expect(info.code).toBe(3);
  });

  it('writes to stdin and receives stdout', async () => {
    const proc = spawnFixture('echo');
    const { stdout } = collect(proc);

    proc.write('hello\n');
    await waitFor(() => stdout.includes('echo:hello'));

    await proc.kill();
  });

  it('passes only explicit/allowlisted env vars and no inherited secrets', async () => {
    const previousSecret = process.env.MODEL_API_KEY;
    process.env.MODEL_API_KEY = 'sk-parent-secret';

    try {
      const withoutExtra = spawnFixture('env');
      const firstLines = collect(withoutExtra);
      await withoutExtra.exited;
      const first = JSON.parse(firstLines.stdout[0]) as Record<
        string,
        string | undefined
      >;
      expect(first.PATH).toBeDefined();
      expect(first.MODEL_API_KEY).toBeUndefined();

      const withExtra = spawnFixture('env', {
        env: { MODEL_API_KEY: 'sk-child', CUSTOM: 'custom-value' },
        envAllowlist: ['CUSTOM'],
      });
      const secondLines = collect(withExtra);
      await withExtra.exited;
      const second = JSON.parse(secondLines.stdout[0]) as Record<
        string,
        string | undefined
      >;
      expect(second.MODEL_API_KEY).toBe('sk-child');
      expect(second.CUSTOM).toBe('custom-value');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.MODEL_API_KEY;
      } else {
        process.env.MODEL_API_KEY = previousSecret;
      }
    }
  });

  it('truncates overlong lines without unbounded buffering', async () => {
    const proc = spawnFixture('long', { maxLineChars: 20 });
    const { stdout } = collect(proc);

    await proc.exited;

    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toHaveLength(20);
    expect(stdout[0].endsWith('…')).toBe(true);
  });

  it('kill() is idempotent and resolves after exit', async () => {
    const proc = spawnFixture('hang');
    await waitFor(() => proc.running);

    await Promise.all([proc.kill(), proc.kill()]);
    await proc.exited;
    await proc.kill();

    expect(proc.running).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'kills the whole process tree on Windows',
    async () => {
      const proc = spawnFixture('tree');
      const { stdout } = collect(proc);

      await waitFor(() =>
        stdout.some((line) => line.startsWith('grandchild:'))
      );
      const line = stdout.find((entry) =>
        entry.startsWith('grandchild:')
      );
      if (line === undefined) throw new Error('grandchild line missing');
      const grandchildPid = Number(line.split(':')[1]);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);

      await proc.kill();
      await proc.exited;
      await waitFor(() => !isAlive(grandchildPid), 5_000);

      expect(isAlive(grandchildPid)).toBe(false);
    }
  );

  it('rejects exited when spawn fails', async () => {
    const proc = spawnManaged({
      command: 'agentbox-no-such-command-xyz',
      cwd: process.cwd(),
    });
    spawned.push(proc);

    await expect(proc.exited).rejects.toMatchObject({
      code: 'SPAWN_FAILED',
    });
    expect(proc.running).toBe(false);
    await proc.kill();
  });

  it('rejects write() after the process exited', async () => {
    const proc = spawnFixture('exit');
    await proc.exited;

    expectRuntimeError(() => proc.write('late'), 'NOT_RUNNING');
  });

  it('validates options', () => {
    expectRuntimeError(
      () => spawnManaged({ command: '', cwd: process.cwd() }),
      'INVALID_ARGUMENT'
    );
    expectRuntimeError(
      () => spawnManaged({ command: process.execPath, cwd: '' }),
      'INVALID_ARGUMENT'
    );
    expectRuntimeError(
      () =>
        spawnManaged({
          command: process.execPath,
          cwd: process.cwd(),
          maxLineChars: 0,
        }),
      'INVALID_ARGUMENT'
    );
    expectRuntimeError(
      () =>
        spawnManaged({
          command: process.execPath,
          cwd: process.cwd(),
          killGraceMs: -1,
        }),
      'INVALID_ARGUMENT'
    );
    expectRuntimeError(
      () =>
        spawnManaged({
          command: process.execPath,
          cwd: process.cwd(),
          env: { CUSTOM: 1 as unknown as string },
        }),
      'INVALID_ARGUMENT'
    );
    expectRuntimeError(
      () =>
        spawnManaged({
          command: process.execPath,
          cwd: process.cwd(),
          envAllowlist: [1 as unknown as string],
        }),
      'INVALID_ARGUMENT'
    );
  });

  it('stops delivering lines after unsubscribe', async () => {
    const proc = spawnFixture('lines');
    let seen = 0;
    const off = proc.onStdoutLine(() => {
      seen += 1;
    });
    off();

    await proc.exited;

    expect(seen).toBe(0);
  });
});
