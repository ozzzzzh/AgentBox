import { spawn, type ChildProcess } from 'node:child_process';
import { RuntimeError } from './errors.js';
import { buildChildEnv } from './security/env.js';

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** Extra environment variables (e.g. a model API key). Never log these. */
  env?: Record<string, string>;
  /** Additional parent variables to inherit beyond the platform allowlist. */
  envAllowlist?: string[];
  /** Max characters kept per line; longer lines are truncated. Default 1 MiB. */
  maxLineChars?: number;
  /** Grace period before force-killing. Default 3000 ms. */
  killGraceMs?: number;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

export type LineListener = (line: string) => void;
export type ExitListener = (info: ExitInfo) => void;

export interface ManagedProcess {
  readonly pid: number | undefined;
  readonly running: boolean;
  /** Resolves after the process exited and its stdio streams closed. */
  readonly exited: Promise<ExitInfo>;

  write(data: string): void;
  onStdoutLine(callback: LineListener): () => void;
  onStderrLine(callback: LineListener): () => void;
  onExit(callback: ExitListener): () => void;
  /** Idempotent terminate. Kills the whole process tree where supported. */
  kill(): Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function disableUnhandledRejection(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }
  });
}

function truncateLine(line: string, maxLineChars: number): string {
  if (line.length <= maxLineChars) return line;
  if (maxLineChars <= 1) return line.slice(0, maxLineChars);
  return `${line.slice(0, maxLineChars - 1)}…`;
}

/**
 * Incremental line splitter for stdout/stderr.
 *
 * Handles CRLF, partial chunks, a final line without a newline (on flush),
 * and bounds memory for pathological output by truncating overlong lines.
 */
class LineBuffer {
  private buffer = '';
  private discarding = false;

  constructor(
    private readonly maxLineChars: number,
    private readonly emit: LineListener
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;

    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;

      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);

      if (this.discarding) {
        // The overlong line was already emitted; drop the rest of it.
        this.discarding = false;
        continue;
      }
      this.emitLine(raw);
    }

    if (!this.discarding && this.buffer.length > this.maxLineChars) {
      this.emitLine(this.buffer);
      this.buffer = '';
      this.discarding = true;
    }
  }

  flush(): void {
    if (!this.discarding && this.buffer.length > 0) {
      this.emitLine(this.buffer);
    }
    this.buffer = '';
    this.discarding = false;
  }

  private emitLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    this.emit(truncateLine(line, this.maxLineChars));
  }
}

interface NormalizedSpawnOptions {
  maxLineChars: number;
  killGraceMs: number;
}

function invalid(message: string): RuntimeError {
  return new RuntimeError('INVALID_ARGUMENT', message);
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${name} must be a non-empty string`);
  }
}

function assertPositiveInteger(
  name: string,
  value: unknown
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer`);
  }
}

function normalizeOptions(options: SpawnOptions): NormalizedSpawnOptions {
  assertNonEmptyString('command', options.command);
  assertNonEmptyString('cwd', options.cwd);

  if (options.args !== undefined) {
    if (
      !Array.isArray(options.args) ||
      options.args.some((arg) => typeof arg !== 'string')
    ) {
      throw invalid('args must be an array of strings');
    }
  }

  if (options.env !== undefined) {
    if (
      typeof options.env !== 'object' ||
      options.env === null ||
      Array.isArray(options.env)
    ) {
      throw invalid('env must be an object of string values');
    }
    for (const [key, value] of Object.entries(options.env)) {
      if (key.trim() === '' || typeof value !== 'string') {
        throw invalid('env must be an object of non-empty string keys and string values');
      }
    }
  }

  if (options.envAllowlist !== undefined) {
    if (
      !Array.isArray(options.envAllowlist) ||
      options.envAllowlist.some((name) => typeof name !== 'string')
    ) {
      throw invalid('envAllowlist must be an array of strings');
    }
  }

  const maxLineChars = options.maxLineChars ?? 1024 * 1024;
  assertPositiveInteger('maxLineChars', maxLineChars);

  const killGraceMs = options.killGraceMs ?? 3_000;
  assertPositiveInteger('killGraceMs', killGraceMs);

  return { maxLineChars, killGraceMs };
}

class ManagedProcessImpl implements ManagedProcess {
  readonly exited: Promise<ExitInfo>;

  private readonly exitDeferred = deferred<ExitInfo>();
  private readonly stdoutListeners = new Set<LineListener>();
  private readonly stderrListeners = new Set<LineListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly killGraceMs: number;

  private exitInfo: ExitInfo | undefined;
  private exitedFlag = false;
  private killPromise: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcess,
    options: NormalizedSpawnOptions,
    private readonly command: string
  ) {
    this.exited = this.exitDeferred.promise;
    disableUnhandledRejection(this.exited);
    this.killGraceMs = options.killGraceMs;

    const stdout = new LineBuffer(options.maxLineChars, (line) =>
      this.emitLine(this.stdoutListeners, line)
    );
    const stderr = new LineBuffer(options.maxLineChars, (line) =>
      this.emitLine(this.stderrListeners, line)
    );

    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
    this.child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
    this.child.stdout?.on('end', () => stdout.flush());
    this.child.stderr?.on('end', () => stderr.flush());

    this.child.once('exit', (code, signal) => {
      this.exitedFlag = true;
      const info: ExitInfo = { code, signal, at: Date.now() };
      this.exitInfo = info;
      this.emitExit(info);
    });

    this.child.once('close', () => {
      stdout.flush();
      stderr.flush();
      if (this.exitInfo === undefined) {
        this.exitedFlag = true;
        this.exitInfo = { code: null, signal: null, at: Date.now() };
      }
      this.exitDeferred.resolve(this.exitInfo);
    });

    this.child.once('error', (error) => {
      if (this.exitInfo !== undefined) return;
      this.exitedFlag = true;
      this.exitDeferred.reject(
        new RuntimeError(
          'SPAWN_FAILED',
          `failed to spawn ${this.command}: ${error.message}`,
          error
        )
      );
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return !this.exitedFlag && this.child.pid !== undefined;
  }

  write(data: string): void {
    if (!this.running) {
      throw new RuntimeError('NOT_RUNNING', 'process is not running');
    }
    const stdin = this.child.stdin;
    if (stdin === null || stdin.destroyed) {
      throw new RuntimeError('NOT_RUNNING', 'process stdin is not writable');
    }
    stdin.write(data);
  }

  onStdoutLine(callback: LineListener): () => void {
    return this.subscribe(this.stdoutListeners, callback);
  }

  onStderrLine(callback: LineListener): () => void {
    return this.subscribe(this.stderrListeners, callback);
  }

  onExit(callback: ExitListener): () => void {
    if (this.exitInfo !== undefined) {
      try {
        callback(this.exitInfo);
      } catch {
        // Listener failures must not break process lifecycle.
      }
      return () => undefined;
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  kill(): Promise<void> {
    if (this.killPromise === undefined) {
      this.killPromise = this.doKill();
    }
    return this.killPromise;
  }

  private subscribe(
    listeners: Set<LineListener>,
    callback: LineListener
  ): () => void {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }

  private emitLine(listeners: Set<LineListener>, line: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(line);
      } catch {
        // Listener failures must not break process I/O.
      }
    }
  }

  private emitExit(info: ExitInfo): void {
    for (const listener of [...this.exitListeners]) {
      try {
        listener(info);
      } catch {
        // Listener failures must not break process lifecycle.
      }
    }
  }

  private async doKill(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined || this.exitedFlag) return;

    if (process.platform === 'win32') {
      await runTaskkill(pid);
      await this.waitForExit(this.killGraceMs);
      if (this.exitedFlag) return;

      try {
        this.child.kill();
      } catch {
        // Ignore; best effort fallback.
      }
      await this.waitForExit(1_000);
      return;
    }

    this.signalGroup(pid, 'SIGTERM');
    await this.waitForExit(this.killGraceMs);
    if (this.exitedFlag) return;

    this.signalGroup(pid, 'SIGKILL');
    await this.waitForExit(1_000);
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Ignore: the process may already be gone.
      }
    }
  }

  private async waitForExit(ms: number): Promise<void> {
    if (this.exitedFlag) return;
    await Promise.race([
      this.exited.then(
        () => undefined,
        () => undefined
      ),
      delay(ms),
    ]);
  }
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    let killer: ChildProcess | undefined;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(() => {
      try {
        killer?.kill();
      } catch {
        // Ignore.
      }
      finish();
    }, 5_000);

    try {
      killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        env: buildChildEnv(process.env),
      });
    } catch {
      finish();
      return;
    }

    killer.once('error', finish);
    killer.once('exit', finish);
  });
}

/**
 * Spawn a child process with:
 *  - no shell interpolation (command/args are separate)
 *  - a minimal allowlisted environment (see buildChildEnv)
 *  - line-buffered stdout/stderr
 *  - idempotent tree kill (taskkill /T /F on Windows, process group on POSIX)
 */
export function spawnManaged(options: SpawnOptions): ManagedProcess {
  const normalized = normalizeOptions(options);

  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: buildChildEnv(
      process.env,
      options.env ?? {},
      options.envAllowlist ?? []
    ),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    shell: false,
  });

  return new ManagedProcessImpl(child, normalized, options.command);
}
