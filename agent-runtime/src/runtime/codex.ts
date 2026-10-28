import { RuntimeError } from '../errors.js';
import type {
  AgentRuntime,
  EventListener,
  RuntimeCapabilities,
  RuntimeConfig,
  TurnHandle,
  TurnInput,
} from '../types.js';

/**
 * Codex app-server adapter (primary runtime).
 *
 * STATUS: STUB. Phase 0 must probe the installed Codex version first and fill
 * `docs/RUNTIME-PROBE.md`; do not assume method names.
 *
 * Expected integration surface (verify against the installed version):
 *  - spawn `codex app-server` (stdio JSON-RPC)
 *  - handshake / initialize
 *  - create conversation, send user turn
 *  - notifications: assistant text, tool calls, file changes, turn end, errors
 *  - approvals: request -> resolve
 *  - cancel: interrupt turn
 *  - config: CODEX_HOME / config.toml
 *      model_provider = "<id>"
 *      [model_providers.<id>]
 *      base_url = "http://172.22.26.117:8085/v1"
 *      env_key = "MODEL_API_KEY"
 *      wire_api = "chat"
 *
 * Security:
 *  - disable telemetry/auto-update/cloud login before production use
 *  - bind nothing to 0.0.0.0
 *  - kill the process tree on Windows (`taskkill /pid <pid> /T /F`)
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

  constructor(private readonly config: RuntimeConfig) {}

  async start(): Promise<void> {
    const command = this.config.codex?.command ?? 'codex';
    throw new RuntimeError(
      'NOT_IMPLEMENTED',
      `CodexRuntime.start() is not implemented (command: ${command}). ` +
        'Run Phase 0 in docs/RUNTIME-PROBE.md, then implement Phase 2 in IMPLEMENTATION_PLAN.md.'
    );
  }

  async startTurn(input: TurnInput): Promise<TurnHandle> {
    throw new RuntimeError(
      'NOT_IMPLEMENTED',
      `CodexRuntime.startTurn() is not implemented (workspace: ${input.workspaceRoot}).`
    );
  }

  onEvent(_listener: EventListener): () => void {
    // Phase 2: fan out normalized AgentEvent to listeners.
    return () => undefined;
  }

  async abort(turnId: string): Promise<void> {
    throw new RuntimeError('NOT_IMPLEMENTED', `CodexRuntime.abort(${turnId}) is not implemented.`);
  }

  async stop(): Promise<void> {
    // Phase 2: stop the app-server child process and kill its tree.
  }
}
