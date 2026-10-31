/**
 * AgentBox runtime contract.
 *
 * IMPORTANT:
 *  - This package is pure Node/TypeScript. It must NOT import `vscode`
 *    or anything from `pluginVersion/`.
 *  - All runtime-specific events must be mapped into AgentEvent.
 *  - OpenClaw is intentionally not supported here (deprecated).
 */

export type RuntimeId = 'codex' | 'opencode';

/**
 * Version of the AgentEvent contract. Bump on any breaking change so
 * persisted JSONL traces can be interpreted correctly.
 */
export const AGENT_EVENT_SCHEMA_VERSION = 1;

export type StopReason =
  | 'end_turn'
  | 'max_steps'
  | 'cancelled'
  | 'error'
  | 'policy_denied';

/** Caller decision for an `approval.request` event. */
export type ApprovalDecision = 'allow' | 'deny';

export interface RuntimeCapabilities {
  streaming: boolean;
  toolEvents: boolean;
  fileEvents: boolean;
  approvals: boolean;
  mcp: boolean;
  /** Protocol/version reported by the runtime, for diagnostics. */
  protocolVersion?: string;
}

export interface Limits {
  maxSteps: number;
  maxToolCallsPerTurn: number;
  maxOutputCharsPerTool: number;
  maxContextTokens: number;
  toolTimeoutMs: number;
  turnTimeoutMs: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxSteps: 12,
  maxToolCallsPerTurn: 30,
  maxOutputCharsPerTool: 20_000,
  maxContextTokens: 100_000,
  toolTimeoutMs: 120_000,
  turnTimeoutMs: 600_000,
});

export interface TurnInput {
  prompt: string;
  /**
   * Pre-assembled context (knowledge/skills).
   * Knowledge integration is a later phase; the runtime only sees the string.
   */
  context?: string;
  workspaceRoot: string;
  /** Per-turn overrides, merged over RuntimeConfig.limits. */
  limits?: Partial<Limits>;
  /**
   * Opaque caller metadata, echoed once in `turn.start`.
   * Must be JSON-serializable and must not contain secrets.
   */
  metadata?: Record<string, unknown>;
}

export type AgentEvent =
  | {
      type: 'turn.start';
      turnId: string;
      runtime: RuntimeId;
      at: number;
      metadata?: Record<string, unknown>;
    }
  | { type: 'text.delta'; turnId: string; text: string; at: number }
  | { type: 'tool.start'; turnId: string; callId: string; name: string; args: unknown; at: number }
  | { type: 'tool.end'; turnId: string; callId: string; name: string; ok: boolean; result: string; at: number }
  | { type: 'approval.request'; turnId: string; callId: string; name: string; args: unknown; at: number }
  | { type: 'file.changed'; turnId: string; path: string; at: number }
  | { type: 'token.usage'; turnId: string; usage: TokenUsageSnapshot; at: number }
  | { type: 'turn.end'; turnId: string; reason: StopReason; at: number }
  | { type: 'error'; turnId: string; code: string; message: string; at: number };

export interface TokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface TokenUsageSnapshot {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface TurnHandle {
  turnId: string;
}

export type EventListener = (event: AgentEvent) => void;

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: RuntimeCapabilities;

  /** Spawn/connect the underlying runtime and wait until it is ready. */
  start(): Promise<void>;

  /**
   * Start one user turn. Events are delivered via onEvent().
   * Only one turn may be active per runtime instance; a concurrent call
   * must reject with TURN_IN_PROGRESS.
   */
  startTurn(input: TurnInput): Promise<TurnHandle>;

  /** Subscribe to normalized events. Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void;

  /**
   * Resolve a pending `approval.request`.
   * A denied tool must never be executed; adapters relay the decision to the
   * child process. Unknown/late resolutions reject with APPROVAL_NOT_PENDING.
   */
  resolveApproval(
    turnId: string,
    callId: string,
    decision: ApprovalDecision
  ): Promise<void>;

  /** Request cancellation of a turn. Must eventually emit turn.end(cancelled). */
  abort(turnId: string): Promise<void>;

  /** Stop the runtime and release the process/port. Idempotent. */
  stop(): Promise<void>;
}

export interface CodexRuntimeConfig {
  /** Default: "codex" */
  command?: string;
  /** Arguments after the command. Default: ["app-server", "--listen", "stdio://"]. */
  args?: string[];
  /** Model id passed to Codex. */
  model?: string;
  /** Provider id written to config.toml. Default: "agentbox" when baseUrl is set. */
  provider?: string;
  /**
   * OpenAI-compatible provider base URL. When set, the adapter writes an
   * isolated CODEX_HOME/config.toml with a model_providers entry.
   */
  baseUrl?: string;
  /** Codex 0.165 only accepts "responses". Default: "responses". */
  wireApi?: 'responses';
  /** Environment variable name holding the provider API key. Default: MODEL_API_KEY. */
  apiKeyEnv?: string;
  /** Optional absolute model catalog JSON path (silences fallback metadata warnings). */
  modelCatalogJson?: string;
  /** Isolated CODEX_HOME. Default: a temporary directory removed on stop(). */
  home?: string;
  /** internal = default intranet provider; external = user-confirmed public provider. */
  scope?: 'internal' | 'external';
  /** Thread approval policy. Default: "on-request". */
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  /** Codex permissions profile id. Default: ":workspace" on Windows, "read-only" otherwise. */
  permissions?: string;
  /**
   * On Windows, run windowsSandbox/setupStart({mode:"unelevated"}) once when
   * readiness is notConfigured, then restart app-server. Default: true.
   * Set false to fail fast and require an explicit setup step.
   */
  autoSetupSandbox?: boolean;
  /**
   * Extra developer instructions sent with `thread/start`. Appended to Codex's
   * built-in instructions. Use this for environment/shell and file-hygiene
   * guidance; do not put secrets here.
   */
  developerInstructions?: string;
  /** Extra env for the child process. Never commit secrets. */
  env?: Record<string, string>;
}

export interface OpenCodeRuntimeConfig {
  /** Default: "opencode" */
  command?: string;
  /** Default: 127.0.0.1; only loopback addresses are allowed. */
  hostname?: string;
  /** Default: 0 (pick a free port) */
  port?: number;
  /** Model id passed to OpenCode, if supported. */
  model?: string;
  /** Extra env for the child process. Never commit secrets. */
  env?: Record<string, string>;
}

export interface RuntimeConfig {
  runtime: RuntimeId;
  workspaceRoot: string;
  /** Default per-turn limits, merged over DEFAULT_LIMITS. */
  limits?: Partial<Limits>;
  codex?: CodexRuntimeConfig;
  opencode?: OpenCodeRuntimeConfig;
}
