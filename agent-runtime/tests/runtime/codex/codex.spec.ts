import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexRuntime } from '../../../src/runtime/codex/index.js';
import { runtimeContractSuite } from '../../../src/testing/contract.js';
import type { CodexRuntimeConfig, AgentEvent, RuntimeConfig } from '../../../src/types.js';

const mockServer = fileURLToPath(
  new URL('../../fixtures/codex/mock-app-server.cjs', import.meta.url)
);
const workspaceRoot = mkdtempSync(join(tmpdir(), 'agentbox-codex-'));

function makeConfig(
  codex: Partial<CodexRuntimeConfig> = {}
): RuntimeConfig {
  return {
    runtime: 'codex',
    workspaceRoot,
    limits: { turnTimeoutMs: 5_000 },
    codex: {
      command: process.execPath,
      args: [mockServer],
      model: 'mock-model',
      ...codex,
    },
  };
}

runtimeContractSuite('CodexRuntime', () => {
  const runtime = new CodexRuntime(makeConfig());
  return {
    runtime,
    workspaceRoot,
    startNormalTurn: () =>
      runtime.startTurn({
        prompt: 'contract test',
        workspaceRoot,
        limits: { turnTimeoutMs: 5_000 },
      }),
    startFailedToolTurn: () =>
      runtime.startTurn({
        prompt: '__failed_tool__',
        workspaceRoot,
        limits: { turnTimeoutMs: 5_000 },
      }),
    startLongTurn: (limits) =>
      runtime.startTurn({
        prompt: '__long__',
        workspaceRoot,
        limits: limits ?? { turnTimeoutMs: 5_000 },
      }),
    startApprovalTurn: async () => {
      const handle = await runtime.startTurn({
        prompt: '__approval__',
        workspaceRoot,
        limits: { turnTimeoutMs: 5_000 },
      });
      return { handle, callId: 'call_approval' };
    },
    dispose: () => runtime.stop(),
  };
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(
  runtime: CodexRuntime,
  events: AgentEvent[],
  predicate: (event: AgentEvent) => boolean,
  timeoutMs = 5_000
): Promise<AgentEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for Codex event');
    }
    void runtime;
    await delay(10);
  }
}

describe('CodexRuntime mapping', () => {
  it('maps text, tool and file events from a normal turn', async () => {
    const runtime = new CodexRuntime(makeConfig());
    const events: AgentEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.start();

    const handle = await runtime.startTurn({
      prompt: 'normal',
      workspaceRoot,
      limits: { turnTimeoutMs: 5_000 },
    });
    await waitForEvent(
      runtime,
      events,
      (event) => event.type === 'turn.end' && event.turnId === handle.turnId
    );

    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text).join(''))
      .toBe('hello world');
    expect(
      events.some(
        (event) =>
          event.type === 'tool.start' &&
          event.name === 'commandExecution' &&
          event.turnId === handle.turnId
      )
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'file.changed' &&
          event.path === 'README.md' &&
          event.turnId === handle.turnId
      )
    ).toBe(true);

    const usage = events.find(
      (event) => event.type === 'token.usage' && event.turnId === handle.turnId
    );
    expect(usage).toBeDefined();
    if (usage?.type === 'token.usage') {
      expect(usage.usage.last.totalTokens).toBe(140);
      expect(usage.usage.total.totalTokens).toBe(380);
    }

    await runtime.stop();
  });

  it('supports approval allow', async () => {
    const runtime = new CodexRuntime(makeConfig());
    const events: AgentEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.start();

    const handle = await runtime.startTurn({
      prompt: '__approval__',
      workspaceRoot,
      limits: { turnTimeoutMs: 5_000 },
    });
    const approval = await waitForEvent(
      runtime,
      events,
      (event) =>
        event.type === 'approval.request' &&
        event.turnId === handle.turnId &&
        event.callId === 'call_approval'
    );
    if (approval.type !== 'approval.request') throw new Error('unexpected event');
    await runtime.resolveApproval(handle.turnId, approval.callId, 'allow');
    await waitForEvent(
      runtime,
      events,
      (event) => event.type === 'turn.end' && event.turnId === handle.turnId
    );

    expect(
      events.some(
        (event) =>
          event.type === 'tool.end' &&
          event.callId === 'call_approval' &&
          event.ok
      )
    ).toBe(true);

    await runtime.stop();
  });

  it('emits error + turn.end when the app-server crashes during a turn', async () => {
    const runtime = new CodexRuntime(makeConfig());
    const events: AgentEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.start();

    const handle = await runtime.startTurn({
      prompt: '__crash__',
      workspaceRoot,
      limits: { turnTimeoutMs: 5_000 },
    });
    const end = await waitForEvent(
      runtime,
      events,
      (event) => event.type === 'turn.end' && event.turnId === handle.turnId
    );

    expect(end.type).toBe('turn.end');
    if (end.type === 'turn.end') expect(end.reason).toBe('error');
    expect(
      events.some(
        (event) =>
          event.type === 'error' &&
          event.code === 'RUNTIME_EXITED' &&
          event.turnId === handle.turnId
      )
    ).toBe(true);

    await runtime.stop();
  });

  it('rejects startTurn before start', async () => {
    const runtime = new CodexRuntime(makeConfig());
    await expect(
      runtime.startTurn({ prompt: 'x', workspaceRoot })
    ).rejects.toMatchObject({ code: 'NOT_RUNNING' });
  });

  it('writes an isolated CODEX_HOME config.toml', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentbox-codex-home-'));
    const runtime = new CodexRuntime(
      makeConfig({
        home,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        env: { DEEPSEEK_API_KEY: 'test-key' },
      })
    );

    await runtime.start();
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(config).toContain('model_provider = "deepseek"');
    expect(config).toContain('[model_providers."deepseek"]');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('env_key = "DEEPSEEK_API_KEY"');
    expect(config).toContain('base_url = "https://api.deepseek.com"');
    expect(config).toContain('[analytics]');

    await runtime.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'win32')(
    'fails start when Windows sandbox is not configured',
    async () => {
      const runtime = new CodexRuntime(
        makeConfig({
          autoSetupSandbox: false,
          env: { MOCK_SANDBOX_STATUS: 'notConfigured' },
        })
      );

      await expect(runtime.start()).rejects.toMatchObject({
        code: 'SANDBOX_NOT_CONFIGURED',
      });
    }
  );
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});
