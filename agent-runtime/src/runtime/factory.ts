import { validateRuntimeConfig } from '../config.js';
import { RuntimeError } from '../errors.js';
import type { AgentRuntime, RuntimeConfig } from '../types.js';
import { CodexRuntime } from './codex/index.js';
import { OpenCodeRuntime } from './opencode.js';

/**
 * Create a runtime adapter from config.
 *
 * Config is validated first so consumers fail fast on bad workspaceRoot/limits.
 * OpenClaw is intentionally NOT supported: it is deprecated for this phase.
 */
export function createRuntime(config: RuntimeConfig): AgentRuntime {
  validateRuntimeConfig(config);

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
