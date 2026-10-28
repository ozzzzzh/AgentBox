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

export type StopReason =
  | 'end_turn'
  | 'max_steps'
  | 'cancelled'
  | 'error'
  | 'policy_denied';

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

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 12,
  maxToolCallsPerTurn: 30,
  maxOutputCharsPerTool: 20_000,
  maxContextTokens: 100_000,
  toolTimeoutMs: 120_000,
  turnTimeoutMs: 600_000,
};

export interface TurnInput {
  prompt: string;
  /**
   * Pre-assembled context (knowledge/skills).
   * Knowledge integration is a later phase; the runtime only sees the string.
   */
  context?: string;
  workspaceRoot: string;
  limits: Limits;
  /** Opaque caller metadata, echoed in events. */
  metadata?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: 'turn.start'; turnId: string; runtime: RuntimeId; at: number }
  | { type: 'text.delta'; turnId: string; text: string; at: number }
  | { type: 'tool.start'; turnId: string; callId: string; name: string; args: unknown; at: number }
  | { type: 'tool.end'; turnId: string; callId: string; name: string; ok: boolean; result: string; at: number }
  | { type: 'approval.request'; turnId: string; callId: string; name: string; args: unknown; at: number }
  | { type: 'file.changed'; turnId: string; path: string; at: number }
  | { type: 'turn.end'; turnId: string; reason: StopReason; at: number }
  | { type: 'error'; turnId: string; code: string; message: string; at: number };

export interface TurnHandle {
  turnId: string;
}

export type EventListener = (event: AgentEvent) => void;

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: RuntimeCapabilities;

  /** Spawn/connect the underlying runtime and wait until it is ready. */
  start(): Promise<void>;

  /** Start one user turn. Events are delivered via onEvent(). */
  startTurn(input: TurnInput): Promise<TurnHandle>;

  /** Subscribe to normalized events. Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void;

  /** Request cancellation of a turn. Must eventually emit turn.end(cancelled). */
  abort(turnId: string): Promise<void>;

  /** Stop the runtime and release the process/port. Idempotent. */
  stop(): Promise<void>;
}

export interface CodexRuntimeConfig {
  /** Default: "codex" */
  command?: string;
  /** Model id passed to Codex, if supported. */
  model?: string;
  /** Provider id configured in Codex config.toml. */
  provider?: string;
  /** Extra env for the child process. Never commit secrets. */
  env?: Record<string, string>;
}

export interface OpenCodeRuntimeConfig {
  /** Default: "opencode" */
  command?: string;
  /** Default: 127.0.0.1 */
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
  limits: Limits;
  codex?: CodexRuntimeConfig;
  opencode?: OpenCodeRuntimeConfig;
}
