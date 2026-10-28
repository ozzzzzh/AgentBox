import { RuntimeError } from '../errors.js';
import type { AgentRuntime, RuntimeConfig } from '../types.js';
import { CodexRuntime } from './codex.js';
import { OpenCodeRuntime } from './opencode.js';

/**
 * Create a runtime adapter from config.
 *
 * OpenClaw is intentionally NOT supported: it is deprecated for this phase.
 */
export function createRuntime(config: RuntimeConfig): AgentRuntime {
  switch (config.runtime) {
    case 'codex':
      return new CodexRuntime(config);
    case 'opencode':
      return new OpenCodeRuntime(config);
    default: {
      const exhaustive: never = config.runtime;
      throw new RuntimeError(
        'INVALID_RUNTIME',
        `Unsupported runtime: ${String(exhaustive)}. Supported: codex, opencode.`
      );
    }
  }
}
