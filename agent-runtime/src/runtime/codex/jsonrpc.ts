import { RuntimeError } from '../../errors.js';
import type { ExitInfo } from '../../process.js';

export interface JsonRpcTransport {
  write(data: string): void;
  onStdoutLine(callback: (line: string) => void): () => void;
  onExit(callback: (info: ExitInfo) => void): () => void;
}

export type JsonRpcNotificationHandler = (
  method: string,
  params: unknown
) => void;

export type JsonRpcServerRequestHandler = (
  method: string,
  params: unknown
) => unknown | Promise<unknown>;

export interface JsonRpcClientOptions {
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Newline-delimited JSON-RPC client for `codex app-server`.
 *
 * Codex 0.165 does NOT use a `jsonrpc: "2.0"` field; messages are
 * `{id, method, params}` / `{id, result|error}` / `{method, params}`.
 */
export class JsonRpcClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<JsonRpcNotificationHandler>();
  private serverRequestHandler: JsonRpcServerRequestHandler | undefined;

  private nextId = 1;
  private disposed = false;
  private exited = false;
  private readonly disposeLine: () => void;
  private readonly disposeExit: () => void;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly transport: JsonRpcTransport,
    options: JsonRpcClientOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.disposeLine = transport.onStdoutLine((line) => this.handleLine(line));
    this.disposeExit = transport.onExit((info) => this.handleExit(info));
  }

  onNotification(handler: JsonRpcNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  setServerRequestHandler(handler: JsonRpcServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** Wait for one notification method; rejects on timeout/dispose. */
  waitForNotification(
    method: string,
    timeoutMs = 30_000
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(
        new RuntimeError('NOT_RUNNING', 'JSON-RPC client is disposed')
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(
          new RuntimeError(
            'TIMEOUT',
            `timed out waiting for notification ${method}`
          )
        );
      }, timeoutMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }
      const off = this.onNotification((name, params) => {
        if (name !== method || settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  request<T>(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(
        new RuntimeError('NOT_RUNNING', 'JSON-RPC client is disposed')
      );
    }
    if (this.exited) {
      return Promise.reject(
        new RuntimeError('RUNTIME_EXITED', 'app-server has exited')
      );
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RuntimeError(
            'TIMEOUT',
            `JSON-RPC request ${method} timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      if (
        typeof timer === 'object' &&
        timer !== null &&
        'unref' in timer
      ) {
        (timer as { unref(): void }).unref();
      }

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.transport.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new RuntimeError(
            'RUNTIME_EXITED',
            `failed to write JSON-RPC request: ${errorMessage(error)}`,
            error
          )
        );
      }
    });
  }

  dispose(reason?: RuntimeError): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeLine();
    this.disposeExit();
    const error =
      reason ?? new RuntimeError('CANCELLED', 'JSON-RPC client disposed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Ignore malformed lines; Codex diagnostics belong on stderr.
      return;
    }
    if (!isRecord(message)) return;

    if (message.id !== undefined && typeof message.method === 'string') {
      void this.handleServerRequest(
        message.id as number | string,
        message.method,
        message.params
      );
      return;
    }

    if (message.id !== undefined) {
      this.handleResponse(message);
      return;
    }

    if (typeof message.method === 'string') {
      this.emitNotification(message.method, message.params);
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const rawId = message.id;
    if (typeof rawId !== 'number') return;
    const pending = this.pending.get(rawId);
    if (pending === undefined) return;

    clearTimeout(pending.timer);
    this.pending.delete(rawId);

    if (message.error !== undefined) {
      const error = isRecord(message.error) ? message.error : {};
      const code = typeof error.code === 'number' ? error.code : -32603;
      const text =
        typeof error.message === 'string'
          ? error.message
          : 'unknown JSON-RPC error';
      pending.reject(
        new RuntimeError('PROTOCOL_ERROR', `JSON-RPC ${code}: ${text}`, error)
      );
      return;
    }

    pending.resolve(message.result);
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    if (this.serverRequestHandler === undefined) {
      this.sendServerError(id, -32601, `unsupported server request: ${method}`);
      return;
    }

    try {
      const result = await this.serverRequestHandler(method, params);
      this.transport.write(
        `${JSON.stringify({ id, result: result ?? {} })}\n`
      );
    } catch (error) {
      this.sendServerError(id, -32603, errorMessage(error));
    }
  }

  private sendServerError(
    id: number | string,
    code: number,
    message: string
  ): void {
    try {
      this.transport.write(
        `${JSON.stringify({ id, error: { code, message } })}\n`
      );
    } catch {
      // The process may have exited while handling the request.
    }
  }

  private emitNotification(method: string, params: unknown): void {
    for (const handler of [...this.notificationHandlers]) {
      try {
        handler(method, params);
      } catch {
        // A listener failure must not break the protocol loop.
      }
    }
  }

  private handleExit(info: ExitInfo): void {
    this.exited = true;
    const error = new RuntimeError(
      'RUNTIME_EXITED',
      `app-server exited (code=${String(info.code)}, signal=${String(info.signal)})`
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
