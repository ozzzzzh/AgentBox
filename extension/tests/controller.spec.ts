import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentRuntime,
  ApprovalDecision,
} from '@agentbox/runtime';
import { FakeRuntime } from '@agentbox/runtime/testing';
import {
  formatArgs,
  RuntimeController,
  truncate,
  type ApprovalPrompt,
  type TurnUi,
} from '../src/controller';
import { ToolLoopDetector } from '../src/loop-detector';

class FakeUi implements TurnUi {
  texts: string[] = [];
  lines: string[] = [];
  errors: string[] = [];
  busy: boolean[] = [];
  approvals: ApprovalPrompt[] = [];

  private readonly resolvers: Array<
    (decision: ApprovalDecision) => void
  > = [];

  appendText(text: string): void {
    this.texts.push(text);
  }

  appendEventLine(line: string): void {
    this.lines.push(line);
  }

  requestApproval(prompt: ApprovalPrompt): Promise<ApprovalDecision> {
    this.approvals.push(prompt);
    return new Promise<ApprovalDecision>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  setBusy(busy: boolean): void {
    this.busy.push(busy);
  }

  showError(message: string): void {
    this.errors.push(message);
  }

  decide(index: number, decision: ApprovalDecision): void {
    const resolve = this.resolvers[index];
    if (resolve === undefined) {
      throw new Error(`no pending approval at index ${index}`);
    }
    resolve(decision);
  }
}

let workspaceRoot: string;
let controllers: RuntimeController[] = [];

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'agentbox-v1-'));
});

afterEach(async () => {
  for (const controller of controllers) {
    await controller.dispose();
  }
  controllers = [];
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function makeController(
  runtime: AgentRuntime,
  ui: FakeUi,
  root = workspaceRoot
): RuntimeController {
  const controller = new RuntimeController({
    runtime,
    workspaceRoot: root,
    limits: { turnTimeoutMs: 5_000 },
    ui,
  });
  controllers.push(controller);
  return controller;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe('RuntimeController', () => {
  it('streams text/tool/file events and returns to idle', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world\n' },
        {
          type: 'tool',
          callId: 'c1',
          name: 'read_file',
          args: { path: 'a.txt' },
          ok: true,
          result: 'file content',
        },
        { type: 'file', path: 'a.txt' },
      ],
    });
    const ui = new FakeUi();
    const controller = makeController(runtime, ui);
    await controller.start();

    const handle = await controller.runTurn('demo');
    expect(handle).not.toBeNull();

    await waitFor(() =>
      ui.lines.some((line) => line.includes('turn end_turn'))
    );

    expect(ui.texts.join('')).toBe('hello world\n');
    expect(ui.lines.some((line) => line.includes('read_file'))).toBe(true);
    expect(ui.lines.some((line) => line.includes('a.txt'))).toBe(true);
    expect(ui.errors).toHaveLength(0);
    expect(controller.busy).toBe(false);
    expect(ui.busy[ui.busy.length - 1]).toBe(false);
  });

  it('prompts for approval and forwards the decision', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [
        {
          type: 'approval',
          callId: 'c1',
          name: 'run_shell',
          args: { command: 'rm -rf /' },
          denyResult: 'denied by user',
        },
      ],
    });
    const ui = new FakeUi();
    const controller = makeController(runtime, ui);
    await controller.start();

    await controller.runTurn('approve');
    await waitFor(() => ui.approvals.length === 1);
    expect(ui.approvals[0]).toMatchObject({
      name: 'run_shell',
      callId: 'c1',
    });

    ui.decide(0, 'deny');
    await waitFor(() =>
      ui.lines.some((line) => line.includes('turn end_turn'))
    );

    expect(ui.lines.some((line) => line.includes('approval deny'))).toBe(true);
    expect(ui.lines.some((line) => line.includes('✗ run_shell'))).toBe(true);
    expect(ui.errors).toHaveLength(0);
    expect(controller.busy).toBe(false);
  });

  it('stops a turn when the same tool call keeps failing', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [
        {
          type: 'tool',
          callId: 'c1',
          name: 'run_shell',
          args: { command: 'broken' },
          ok: false,
          result: 'failed',
        },
        {
          type: 'tool',
          callId: 'c2',
          name: 'run_shell',
          args: { command: 'broken' },
          ok: false,
          result: 'failed',
        },
        { type: 'delay', ms: 10_000 },
      ],
    });
    const ui = new FakeUi();
    const controller = new RuntimeController({
      runtime,
      workspaceRoot,
      limits: { turnTimeoutMs: 5_000 },
      ui,
      loopDetector: new ToolLoopDetector({ maxRepeatedFailures: 2 }),
    });
    controllers.push(controller);
    await controller.start();

    await controller.runTurn('loop');
    await waitFor(() =>
      ui.errors.some((message) => message.includes('循环'))
    );
    await waitFor(() => !controller.busy);

    expect(ui.errors.some((message) => message.includes('相同工具调用'))).toBe(
      true
    );
  });

  it('denies approvals rejected by the file policy', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [
        {
          type: 'approval',
          callId: 'c1',
          name: 'run_shell',
          args: { command: 'rm -rf /' },
          denyResult: 'denied by policy',
        },
      ],
    });
    const ui = new FakeUi();
    const controller = new RuntimeController({
      runtime,
      workspaceRoot,
      limits: { turnTimeoutMs: 5_000 },
      ui,
      approvalPolicy: () => ({
        decision: 'deny',
        reason: 'blocked by test policy',
      }),
    });
    controllers.push(controller);
    await controller.start();

    await controller.runTurn('blocked');
    await waitFor(() =>
      ui.lines.some((line) => line.includes('已按文件策略拒绝'))
    );
    await waitFor(() =>
      ui.lines.some((line) => line.includes('turn end_turn'))
    );

    expect(ui.approvals).toHaveLength(0);
    expect(ui.errors).toHaveLength(0);
    expect(controller.busy).toBe(false);
  });

  it('ignores an approval resolved after the turn has ended', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [
        {
          type: 'approval',
          callId: 'c1',
          name: 'run_shell',
          args: { command: 'rm -rf /' },
          denyResult: 'denied by user',
        },
      ],
    });
    const ui = new FakeUi();
    const controller = makeController(runtime, ui);
    await controller.start();

    await controller.runTurn('approve');
    await waitFor(() => ui.approvals.length === 1);

    await controller.cancel();
    await waitFor(() => !controller.busy);

    ui.decide(0, 'allow');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(ui.errors).toHaveLength(0);
    expect(ui.lines.some((line) => line.includes('approval allow'))).toBe(
      false
    );
  });

  it('cancels an active turn and reports cancelled', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [{ type: 'delay', ms: 10_000 }],
    });
    const ui = new FakeUi();
    const controller = makeController(runtime, ui);
    await controller.start();

    await controller.runTurn('long');
    await waitFor(() => controller.busy);

    const startedAt = Date.now();
    await controller.cancel();
    await waitFor(() => !controller.busy);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(ui.lines.some((line) => line.includes('turn cancelled'))).toBe(
      true
    );
  });

  it('rejects a second turn while one is running', async () => {
    const runtime = new FakeRuntime({
      defaultScript: [{ type: 'delay', ms: 10_000 }],
    });
    const ui = new FakeUi();
    const controller = makeController(runtime, ui);
    await controller.start();

    await controller.runTurn('first');
    const second = await controller.runTurn('second');

    expect(second).toBeNull();
    expect(ui.errors[ui.errors.length - 1]).toContain('already running');
    expect(controller.busy).toBe(true);

    await controller.cancel();
    await waitFor(() => !controller.busy);
  });

  it('shows an error when the workspace is invalid', async () => {
    const runtime = new FakeRuntime();
    const ui = new FakeUi();
    const controller = makeController(
      runtime,
      ui,
      join(workspaceRoot, 'missing-workspace')
    );
    await controller.start();

    const handle = await controller.runTurn('x');

    expect(handle).toBeNull();
    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0]).toContain('INVALID_CONFIG');
    expect(ui.busy[ui.busy.length - 1]).toBe(false);
  });

  it('dispose stops the runtime and clears busy state', async () => {
    const runtime = new FakeRuntime();
    const ui = new FakeUi();
    const controller = makeController(runtime, ui);
    await controller.start();

    await controller.dispose();

    expect(controller.busy).toBe(false);
    expect(ui.busy[ui.busy.length - 1]).toBe(false);
    expect(ui.errors).toHaveLength(0);
  });
});

describe('formatters', () => {
  it('normalizes and truncates text', () => {
    expect(truncate('  a   b  ', 10)).toBe('a b');
    expect(truncate('abcdef', 3)).toBe('abc…');
  });

  it('formats tool arguments as compact JSON', () => {
    expect(formatArgs({ path: 'a.txt' })).toBe('{"path":"a.txt"}');
    expect(formatArgs(undefined)).toBe('undefined');
  });
});
