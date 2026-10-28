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
 * OpenCode server adapter (backup runtime).
 *
 * STATUS: STUB. Phase 0 must probe the installed OpenCode version first and
 * fill `docs/RUNTIME-PROBE.md`.
 *
 * Expected integration surface (verify against the installed version):
 *  - spawn `opencode serve --hostname 127.0.0.1 --port <port>`
 *  - health check
 *  - create session, send prompt
 *  - subscribe to events (SSE / WebSocket / SDK)
 *  - permission request -> resolve
 *  - abort / stop
 *  - provider: OpenAI-compatible -> LiteLLM + Qwen
 *
 * Security:
 *  - bind to 127.0.0.1 only
 *  - disable telemetry/auto-update/cloud login before production use
 *  - kill the process tree on Windows
 */
export class OpenCodeRuntime implements AgentRuntime {
  readonly id = 'opencode' as const;

  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    toolEvents: true,
    fileEvents: false,
    approvals: true,
    mcp: true,
  };

  constructor(private readonly config: RuntimeConfig) {}

  async start(): Promise<void> {
    const command = this.config.opencode?.command ?? 'opencode';
    const port = this.config.opencode?.port ?? 0;
    throw new RuntimeError(
      'NOT_IMPLEMENTED',
      `OpenCodeRuntime.start() is not implemented (command: ${command}, port: ${port}). ` +
        'Run Phase 0 in docs/RUNTIME-PROBE.md, then implement Phase 3 in IMPLEMENTATION_PLAN.md.'
    );
  }

  async startTurn(input: TurnInput): Promise<TurnHandle> {
    throw new RuntimeError(
      'NOT_IMPLEMENTED',
      `OpenCodeRuntime.startTurn() is not implemented (workspace: ${input.workspaceRoot}).`
    );
  }

  onEvent(_listener: EventListener): () => void {
    // Phase 3: map SSE/HTTP events to normalized AgentEvent.
    return () => undefined;
  }

  async abort(turnId: string): Promise<void> {
    throw new RuntimeError('NOT_IMPLEMENTED', `OpenCodeRuntime.abort(${turnId}) is not implemented.`);
  }

  async stop(): Promise<void> {
    // Phase 3: stop the server and release the port.
  }
}
