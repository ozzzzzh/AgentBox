import { RuntimeError } from '../../errors.js';
import { EventBus } from '../../events.js';
import { validateTurnInput, resolveTurnLimits } from '../../config.js';
import { spawnManaged, type ManagedProcess } from '../../process.js';
import { redactSecrets } from '../../security/redact.js';
import { TurnGuard, type TurnContext } from '../../turn.js';
import type {
  AgentRuntime,
  ApprovalDecision,
  EventListener,
  RuntimeCapabilities,
  RuntimeConfig,
  StopReason,
  TokenUsageSnapshot,
  TurnHandle,
  TurnInput,
} from '../../types.js';
import { prepareCodexHome, type PreparedCodexHome } from './config.js';
import { JsonRpcClient } from './jsonrpc.js';
import {
  getAgentMessageDelta,
  getTokenUsage,
  getTurnError,
  getTurnId,
  isApprovalMethod,
  mapApprovalRequest,
  mapApprovalResult,
  mapItem,
  mapTurnStopReason,
} from './mapping.js';

interface ActiveTurn {
  context: TurnContext;
  ourTurnId: string;
  codexTurnId: string | null;
  abortRequested: boolean;
  abortTimer: ReturnType<typeof setTimeout> | null;
  usage: TokenUsageSnapshot | null;
}

interface QueuedNotification {
  method: string;
  params: unknown;
}

const ABORT_GRACE_MS = 5_000;
const RPC_TIMEOUT_MS = 30_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asRuntimeError(error: unknown, fallback: string): RuntimeError {
  if (error instanceof RuntimeError) return error;
  return new RuntimeError('HANDSHAKE_FAILED', `${fallback}: ${errorMessage(error)}`, error);
}

/**
 * Codex app-server adapter.
 *
 * Transport: spawn `codex app-server --listen stdio://` and speak
 * newline-delimited JSON (no `jsonrpc` field). See docs/RUNTIME-PROBE.md.
 */
export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex' as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    toolEvents: true,
    fileEvents: true,
    approvals: true,
    mcp: true,
  };

  private readonly config: RuntimeConfig;
  private readonly bus = new EventBus();
  private readonly guard: TurnGuard;

  private running = false;
  private starting: Promise<void> | null = null;
  private process: ManagedProcess | null = null;
  private rpc: JsonRpcClient | null = null;
  private home: PreparedCodexHome | null = null;
  private threadId: string | null = null;
  private active: ActiveTurn | null = null;
  private startingTurn = false;
  private readonly queued = new Map<string, QueuedNotification[]>();
  private readonly stderr: string[] = [];
  private readonly secrets: string[] = [];

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.guard = new TurnGuard(this.id, this.bus);
    this.bus.on((event) => {
      if (event.type === 'turn.end' && this.active?.ourTurnId === event.turnId) {
        this.clearActive(event.reason);
      }
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.starting !== null) return this.starting;

    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    const codex = this.config.codex ?? {};
    const apiKeyEnv = codex.apiKeyEnv ?? 'MODEL_API_KEY';
    if (codex.baseUrl !== undefined && codex.env?.[apiKeyEnv] === undefined) {
      throw new RuntimeError(
        'INVALID_CONFIG',
        `codex.env.${apiKeyEnv} is required when codex.baseUrl is set`
      );
    }

    this.home = prepareCodexHome(this.config);
    this.secrets.splice(0, this.secrets.length, ...Object.values(codex.env ?? {}));

    try {
      await this.spawnAndInitialize();
      await this.ensureSandboxReady();
      this.running = true;
    } catch (error) {
      await this.stopProcess();
      this.home?.cleanup();
      this.home = null;
      throw asRuntimeError(error, 'Codex app-server start failed');
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    await this.stopProcess();

    const codex = this.config.codex ?? {};
    const spawned = spawnManaged({
      command: codex.command ?? 'codex',
      args: codex.args ?? ['app-server', '--listen', 'stdio://'],
      cwd: this.config.workspaceRoot,
      env: {
        ...(codex.env ?? {}),
        CODEX_HOME: this.home?.home ?? '',
      },
      maxLineChars: 2 * 1024 * 1024,
      killGraceMs: 3_000,
    });
    this.process = spawned;

    spawned.onStderrLine((line) => {
      this.stderr.push(redactSecrets(line, this.secrets).slice(0, 500));
      if (this.stderr.length > 20) this.stderr.shift();
    });
    spawned.onExit((info) => this.handleProcessExit(info));

    const rpc = new JsonRpcClient(spawned, {
      requestTimeoutMs: RPC_TIMEOUT_MS,
    });
    this.rpc = rpc;
    rpc.onNotification((method, params) =>
      this.handleNotification(method, params)
    );
    rpc.setServerRequestHandler((method, params) =>
      this.handleServerRequest(method, params)
    );

    const initialized = await rpc.request<{ userAgent?: string }>(
      'initialize',
      {
        clientInfo: {
          name: 'agentbox-runtime',
          title: 'AgentBox Runtime',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      10_000
    );
    if (typeof initialized?.userAgent === 'string') {
      this.capabilities.protocolVersion = initialized.userAgent;
    }
  }

  private async readSandboxStatus(): Promise<string> {
    if (this.rpc === null) {
      throw new RuntimeError('NOT_RUNNING', 'app-server is not running');
    }
    const result = await this.rpc.request<{ status?: string }>(
      'windowsSandbox/readiness',
      undefined,
      10_000
    );
    return result?.status ?? 'unknown';
  }

  private async ensureSandboxReady(): Promise<void> {
    if (process.platform !== 'win32' || this.rpc === null) return;

    let status: string;
    try {
      status = await this.readSandboxStatus();
    } catch (error) {
      throw new RuntimeError(
        'SANDBOX_NOT_CONFIGURED',
        `unable to read Codex Windows sandbox readiness: ${errorMessage(error)}`,
        error
      );
    }
    if (status === 'ready') return;

    const codex = this.config.codex ?? {};
    if (codex.autoSetupSandbox === false) {
      throw new RuntimeError(
        'SANDBOX_NOT_CONFIGURED',
        'Codex Windows sandbox is not ready. Run windowsSandbox/setupStart ' +
          '({mode:"unelevated"}) once, then restart the app-server. ' +
          `Current status: ${status}`
      );
    }

    const rpc = this.rpc;
    const completed = rpc.waitForNotification(
      'windowsSandbox/setupCompleted',
      180_000
    );
    void completed.catch(() => undefined);

    let started = false;
    try {
      const response = await rpc.request<{ started?: boolean }>(
        'windowsSandbox/setupStart',
        { mode: 'unelevated', cwd: this.config.workspaceRoot },
        30_000
      );
      started = response?.started === true;
    } catch (error) {
      throw new RuntimeError(
        'SANDBOX_NOT_CONFIGURED',
        `windowsSandbox/setupStart failed: ${errorMessage(error)}`,
        error
      );
    }
    if (!started) {
      throw new RuntimeError(
        'SANDBOX_NOT_CONFIGURED',
        'windowsSandbox/setupStart did not start'
      );
    }

    let info: { success?: boolean; error?: string | null };
    try {
      info = (await completed) as { success?: boolean; error?: string | null };
    } catch (error) {
      throw new RuntimeError(
        'SANDBOX_NOT_CONFIGURED',
        `windowsSandbox setup did not complete: ${errorMessage(error)}`,
        error
      );
    }
    if (info?.success !== true) {
      throw new RuntimeError(
        'SANDBOX_NOT_CONFIGURED',
        `windowsSandbox setup failed: ${info?.error ?? 'unknown error'}`
      );
    }

    // Readiness is cached per app-server process; restart after setup.
    await this.spawnAndInitialize();
    const after = await this.readSandboxStatus();
    if (after !== 'ready') {
      throw new RuntimeError(
        'SANDBOX_NOT_CONFIGURED',
        `Codex Windows sandbox still not ready after setup (status: ${after})`
      );
    }
  }

  async startTurn(input: TurnInput): Promise<TurnHandle> {
    if (!this.running || this.rpc === null) {
      throw new RuntimeError('NOT_RUNNING', 'CodexRuntime.start() must be called first');
    }
    if (this.active !== null || this.startingTurn) {
      throw new RuntimeError('TURN_IN_PROGRESS', 'another turn is already active');
    }

    validateTurnInput(input);
    const limits = resolveTurnLimits(this.config, input);
    this.startingTurn = true;

    try {
      if (this.threadId === null) {
        await this.createThread(input.workspaceRoot);
      }

      const context = this.guard.begin({
        turnTimeoutMs: limits.turnTimeoutMs,
        metadata: input.metadata,
      });
      const active: ActiveTurn = {
        context,
        ourTurnId: context.turnId,
        codexTurnId: null,
        abortRequested: false,
        abortTimer: null,
        usage: null,
      };
      this.active = active;

      try {
        const prompt =
          input.context !== undefined && input.context !== ''
            ? `${input.context}\n\n${input.prompt}`
            : input.prompt;

        const result = await this.rpc.request<{ turn?: { id?: string } }>(
          'turn/start',
          {
            threadId: this.threadId,
            input: [
              {
                type: 'text',
                text: prompt,
                text_elements: [],
              },
            ],
          },
          30_000
        );

        const codexTurnId = result?.turn?.id;
        if (typeof codexTurnId !== 'string' || codexTurnId === '') {
          throw new RuntimeError('PROTOCOL_ERROR', 'turn/start returned no turn id');
        }
        active.codexTurnId = codexTurnId;
        this.flushQueued(codexTurnId);

        if (active.abortRequested) {
          void this.sendInterrupt(active);
        }

        return { turnId: context.turnId };
      } catch (error) {
        if (!context.ended) {
          context.emit({
            type: 'error',
            code: error instanceof RuntimeError ? error.code : 'PROTOCOL_ERROR',
            message: redactSecrets(errorMessage(error), this.secrets),
          });
          context.end('error');
        }
        throw asRuntimeError(error, 'Codex turn failed to start');
      }
    } finally {
      this.startingTurn = false;
    }
  }

  private async createThread(workspaceRoot: string): Promise<void> {
    if (this.rpc === null) {
      throw new RuntimeError('NOT_RUNNING', 'app-server is not running');
    }
    const codex = this.config.codex ?? {};
    const providerId =
      codex.provider ?? (codex.baseUrl !== undefined ? 'agentbox' : undefined);

    const params: Record<string, unknown> = {
      cwd: workspaceRoot,
      approvalPolicy: codex.approvalPolicy ?? 'on-request',
      permissions: codex.permissions ?? ':workspace',
    };
    if (codex.model !== undefined) params.model = codex.model;
    if (providerId !== undefined) params.modelProvider = providerId;
    if (
      codex.developerInstructions !== undefined &&
      codex.developerInstructions.trim() !== ''
    ) {
      params.developerInstructions = codex.developerInstructions;
    }

    const result = await this.rpc.request<{ thread?: { id?: string } }>(
      'thread/start',
      params,
      30_000
    );
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string' || threadId === '') {
      throw new RuntimeError('PROTOCOL_ERROR', 'thread/start returned no thread id');
    }
    this.threadId = threadId;
  }

  onEvent(listener: EventListener): () => void {
    return this.bus.on(listener);
  }

  resolveApproval(
    turnId: string,
    callId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    return this.guard.resolveApproval(turnId, callId, decision);
  }

  async abort(turnId: string): Promise<void> {
    const active = this.active;
    if (active === null || active.ourTurnId !== turnId) {
      throw new RuntimeError('TURN_NOT_FOUND', `turn ${turnId} is not active`);
    }

    active.abortRequested = true;
    if (active.codexTurnId !== null) {
      await this.sendInterrupt(active);
    }

    if (active.abortTimer === null) {
      active.abortTimer = setTimeout(() => {
        void this.forceCancel(active);
      }, ABORT_GRACE_MS);
      if (
        typeof active.abortTimer === 'object' &&
        active.abortTimer !== null &&
        'unref' in active.abortTimer
      ) {
        (active.abortTimer as { unref(): void }).unref();
      }
    }
  }

  private async sendInterrupt(active: ActiveTurn): Promise<void> {
    if (this.rpc === null || active.codexTurnId === null || this.threadId === null) {
      return;
    }
    try {
      await this.rpc.request(
        'turn/interrupt',
        { threadId: this.threadId, turnId: active.codexTurnId },
        5_000
      );
    } catch {
      // The turn may have completed between abort() and interrupt.
    }
  }

  private async forceCancel(active: ActiveTurn): Promise<void> {
    if (this.active !== active || active.context.ended) return;

    active.context.emit({
      type: 'error',
      code: 'TIMEOUT',
      message: 'Codex did not stop within 5s; terminating the process tree',
    });
    active.context.end('cancelled');

    this.rpc?.dispose(
      new RuntimeError('CANCELLED', 'Codex aborted after interrupt timeout')
    );
    this.rpc = null;
    const proc = this.process;
    this.process = null;
    this.running = false;
    this.threadId = null;
    if (proc !== null) {
      await proc.kill();
    }
    this.home?.cleanup();
    this.home = null;
  }

  async stop(): Promise<void> {
    if (this.active !== null) {
      this.active.context.end('cancelled');
    }
    this.clearActive('cancelled');
    await this.stopProcess();
    this.home?.cleanup();
    this.home = null;
    this.threadId = null;
    this.queued.clear();
    this.running = false;
  }

  private async stopProcess(): Promise<void> {
    this.rpc?.dispose(new RuntimeError('CANCELLED', 'Codex runtime stopped'));
    this.rpc = null;
    const proc = this.process;
    this.process = null;
    if (proc !== null) {
      await proc.kill();
      await proc.exited.catch(() => undefined);
    }
  }

  private handleProcessExit(info: { code: number | null; signal: string | null }): void {
    if (this.active !== null && !this.active.context.ended) {
      this.active.context.emit({
        type: 'error',
        code: 'RUNTIME_EXITED',
        message: `Codex app-server exited (code=${String(info.code)}, signal=${String(info.signal)})`,
      });
      this.active.context.end(this.active.abortRequested ? 'cancelled' : 'error');
    }
    this.clearActive('error');
    this.running = false;
    this.threadId = null;
  }

  private clearActive(reason: StopReason): void {
    const active = this.active;
    if (active === null) return;
    if (active.abortTimer !== null) {
      clearTimeout(active.abortTimer);
      active.abortTimer = null;
    }
    this.active = null;
    void reason;
  }

  private handleNotification(method: string, params: unknown): void {
    const codexTurnId = getTurnId(params);

    if (codexTurnId !== undefined && this.active !== null) {
      if (this.active.codexTurnId === null) {
        this.enqueue(codexTurnId, method, params);
        return;
      }
      if (this.active.codexTurnId !== codexTurnId) {
        return;
      }
    }

    this.processNotification(method, params);
  }

  private enqueue(codexTurnId: string, method: string, params: unknown): void {
    const list = this.queued.get(codexTurnId) ?? [];
    list.push({ method, params });
    this.queued.set(codexTurnId, list);
  }

  private flushQueued(codexTurnId: string): void {
    const list = this.queued.get(codexTurnId);
    if (list === undefined) return;
    this.queued.delete(codexTurnId);
    for (const item of list) {
      this.processNotification(item.method, item.params);
    }
  }

  private processNotification(method: string, params: unknown): void {
    const active = this.active;
    if (active === null) return;
    const context = active.context;

    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = getAgentMessageDelta(params);
        if (delta !== undefined) {
          context.emit({ type: 'text.delta', text: delta });
        }
        return;
      }

      case 'item/started': {
        if (typeof params !== 'object' || params === null) return;
        const item = (params as { item?: unknown }).item;
        const mapping = mapItem(item, this.config.workspaceRoot, 'started');
        if (mapping?.start !== undefined) {
          context.emit({ type: 'tool.start', ...mapping.start });
        }
        return;
      }

      case 'item/completed': {
        if (typeof params !== 'object' || params === null) return;
        const item = (params as { item?: unknown }).item;
        const mapping = mapItem(item, this.config.workspaceRoot, 'completed');
        if (mapping?.end !== undefined) {
          context.emit({ type: 'tool.end', ...mapping.end });
        }
        for (const file of mapping?.files ?? []) {
          context.emit({ type: 'file.changed', path: file });
        }
        return;
      }

      case 'thread/tokenUsage/updated': {
        const usage = getTokenUsage(params);
        if (usage !== null) {
          active.usage = usage;
          context.emit({ type: 'token.usage', usage });
        }
        return;
      }

      case 'turn/completed': {
        const error = getTurnError(params);
        const status =
          typeof params === 'object' && params !== null
            ? (params as { turn?: { status?: string } }).turn?.status
            : undefined;
        const reason = mapTurnStopReason(status, active.abortRequested);
        if (error !== null) {
          context.emit({
            type: 'error',
            code: error.code,
            message: redactSecrets(error.message, this.secrets),
          });
        }
        if (active.usage !== null) {
          context.emit({ type: 'token.usage', usage: active.usage });
        }
        context.end(reason);
        return;
      }

      case 'error': {
        if (typeof params !== 'object' || params === null) return;
        const record = params as {
          error?: { message?: string; codexErrorInfo?: unknown };
          willRetry?: boolean;
        };
        const message = record.error?.message ?? 'Codex error';
        context.emit({
          type: 'error',
          code: 'RUNTIME_ERROR',
          message: redactSecrets(message, this.secrets),
        });
        return;
      }

      case 'thread/status/changed': {
        if (typeof params !== 'object' || params === null) return;
        const status = (params as { status?: { type?: string } }).status;
        if (status?.type === 'systemError') {
          context.emit({
            type: 'error',
            code: 'RUNTIME_EXITED',
            message: 'Codex thread entered systemError',
          });
          context.end('error');
        }
        return;
      }

      default:
        return;
    }
  }

  private async handleServerRequest(
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (!isApprovalMethod(method)) {
      throw new RuntimeError('PROTOCOL_ERROR', `unsupported server request: ${method}`);
    }

    const mapping = mapApprovalRequest(method, params);
    const active = this.active;
    if (mapping === null || active === null) {
      if (method === 'item/permissions/requestApproval') {
        throw new RuntimeError('POLICY_DENIED', 'no active turn for permission request');
      }
      return { decision: 'decline' };
    }

    return new Promise<unknown>((resolve, reject) => {
      active.context.requestApproval(
        { callId: mapping.callId, name: mapping.name, args: mapping.args },
        (decision) => {
          try {
            resolve(mapApprovalResult(method, decision, params));
          } catch (error) {
            reject(error);
          }
        },
        () => {
          try {
            resolve(mapApprovalResult(method, 'deny', params));
          } catch (error) {
            reject(error);
          }
        }
      );
    });
  }
}
