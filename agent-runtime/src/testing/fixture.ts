import type { RuntimeContractFixture } from './contract.js';
import {
  FakeRuntime,
  type FakeStep,
  type FakeTurnScript,
} from './fake-runtime.js';
import type { Limits, RuntimeId, TurnInput } from '../types.js';

export interface FakeRuntimeContractFixtureOptions {
  workspaceRoot: string;
  runtimeId?: RuntimeId;
  defaultScript?: FakeStep[] | FakeTurnScript;
}

/** Wire a FakeRuntime into the shared contract suite. */
export function createFakeRuntimeContractFixture(
  options: FakeRuntimeContractFixtureOptions
): RuntimeContractFixture {
  const runtime = new FakeRuntime({
    runtimeId: options.runtimeId,
    defaultScript: options.defaultScript,
  });

  const input = (limits?: Partial<Limits>): TurnInput => ({
    prompt: 'contract test',
    workspaceRoot: options.workspaceRoot,
    ...(limits !== undefined ? { limits } : {}),
  });

  return {
    runtime,
    workspaceRoot: options.workspaceRoot,

    startNormalTurn: () => runtime.startTurn(input()),

    startLongTurn: (limits) => {
      runtime.enqueueTurn({ steps: [{ type: 'delay', ms: 10_000 }] });
      return runtime.startTurn(input(limits ?? { turnTimeoutMs: 2_000 }));
    },

    startFailedToolTurn: () => {
      runtime.enqueueTurn({
        steps: [
          {
            type: 'tool',
            callId: 'c-fail',
            name: 'write_file',
            ok: false,
            result: 'permission denied',
          },
        ],
      });
      return runtime.startTurn(input());
    },

    startApprovalTurn: async () => {
      runtime.enqueueTurn({
        steps: [
          {
            type: 'approval',
            callId: 'c-approval',
            name: 'shell',
            args: { cmd: 'rm -rf /' },
            denyResult: 'denied by policy',
          },
        ],
      });
      const handle = await runtime.startTurn(input({ turnTimeoutMs: 5_000 }));
      return { handle, callId: 'c-approval' };
    },

    dispose: () => runtime.stop(),
  };
}
