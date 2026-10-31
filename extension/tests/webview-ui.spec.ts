import { describe, expect, it } from 'vitest';
import type { HostToWebview } from '../src/chat-protocol';
import { WebviewTurnUi } from '../src/ui/webview-ui';

function collect(): {
  messages: HostToWebview[];
  ui: WebviewTurnUi;
} {
  const messages: HostToWebview[] = [];
  return { messages, ui: new WebviewTurnUi((message) => messages.push(message)) };
}

const prompt = {
  turnId: 't1',
  callId: 'c1',
  name: 'commandExecution',
  args: { command: 'Get-ChildItem' },
};

describe('WebviewTurnUi', () => {
  it('maps streaming events to protocol messages', () => {
    const { messages, ui } = collect();

    ui.turnStarted('t1');
    ui.appendText('hello');
    ui.toolStarted('c1', 'commandExecution', { command: 'ls' });
    ui.toolEnded('c1', 'commandExecution', true, 'ok');
    ui.fileChanged('a.txt');
    ui.errorEvent('RUNTIME_ERROR', 'boom');
    ui.turnEnded('end_turn');

    expect(messages.map((message) => message.type)).toEqual([
      'turn.start',
      'assistant.delta',
      'tool.start',
      'tool.end',
      'file.changed',
      'error',
      'turn.end',
    ]);
  });

  it('posts an approval request and forwards the decision', async () => {
    const { messages, ui } = collect();

    const decision = ui.requestApproval({
      ...prompt,
      warning: 'file policy warning',
    });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'approval.request',
        id: 'approval-1',
        turnId: 't1',
        callId: 'c1',
        name: 'commandExecution',
        warning: 'file policy warning',
      })
    );

    ui.resolveApproval('approval-1', 'allow');
    await expect(decision).resolves.toBe('allow');
    expect(messages).toContainEqual({
      type: 'approval.resolved',
      id: 'approval-1',
      decision: 'allow',
    });
  });

  it('forwards token usage as turn/session totals', () => {
    const { messages, ui } = collect();

    ui.tokenUsage({
      last: {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 40,
        reasoningOutputTokens: 5,
        totalTokens: 140,
      },
      total: {
        inputTokens: 300,
        cachedInputTokens: 0,
        outputTokens: 80,
        reasoningOutputTokens: 10,
        totalTokens: 380,
      },
      modelContextWindow: 128_000,
    });

    expect(messages).toContainEqual({
      type: 'token.usage',
      turn: 140,
      session: 380,
    });
  });

  it('expires pending approvals when the turn ends', async () => {
    const { messages, ui } = collect();

    const decision = ui.requestApproval(prompt);
    ui.turnEnded('cancelled');

    await expect(decision).resolves.toBe('deny');
    expect(messages).toContainEqual({
      type: 'approval.cancelled',
      id: 'approval-1',
    });
    expect(messages[messages.length - 1]).toEqual({
      type: 'turn.end',
      reason: 'cancelled',
    });
  });

  it('resolves pending approvals as deny on dispose without posting', async () => {
    const { messages, ui } = collect();

    const decision = ui.requestApproval(prompt);
    const before = messages.length;
    ui.dispose();

    await expect(decision).resolves.toBe('deny');
    expect(messages).toHaveLength(before);
  });
});
