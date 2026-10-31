'use strict';

/**
 * Minimal Codex app-server protocol mock for M6 tests.
 * Speaks newline-delimited JSON: {id,method,params} / {id,result|error}.
 */

const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });
let nextServerRequest = 1;
let threadCounter = 0;
let turnCounter = 0;
const turns = new Map();
let currentThreadId = 'thread_mock_1';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ method, params, emittedAtMs: Date.now() });
}

function respond(id, result) {
  send({ id, result });
}

function beginTurn(turnId, prompt, threadId) {
  const mode = prompt.includes('__crash__')
    ? 'crash'
    : prompt.includes('__long__')
      ? 'long'
      : prompt.includes('__approval__')
        ? 'approval'
        : prompt.includes('__failed_tool__')
          ? 'failed'
          : 'normal';

  turns.set(turnId, { mode, threadId, prompt });
  notify('turn/started', {
    threadId,
    turn: {
      id: turnId,
      rootTurnId: turnId,
      items: [],
      itemsView: 'notLoaded',
      status: 'inProgress',
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      durationMs: null,
    },
  });

  if (mode === 'crash') {
    process.exit(1);
  }

  if (mode === 'normal') {
    notify('item/started', {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'userMessage',
        id: 'item_user',
        clientId: null,
        content: [{ type: 'text', text: prompt, text_elements: [] }],
      },
    });
    notify('item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: 'item_agent',
      delta: 'hello ',
    });
    notify('item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: 'item_agent',
      delta: 'world',
    });
    notify('item/started', {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'commandExecution',
        id: 'call_1',
        command: 'echo hi',
        cwd: process.cwd(),
        status: 'inProgress',
        aggregatedOutput: null,
      },
    });
    notify('item/completed', {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: {
        type: 'commandExecution',
        id: 'call_1',
        command: 'echo hi',
        cwd: process.cwd(),
        status: 'completed',
        aggregatedOutput: 'hi',
        exitCode: 0,
      },
    });
    notify('item/started', {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'fileChange',
        id: 'file_1',
        changes: [
          {
            path: `${process.cwd()}\\README.md`,
            kind: { type: 'update', move_path: null },
            diff: 'mock diff',
          },
        ],
        status: 'inProgress',
      },
    });
    notify('item/completed', {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: {
        type: 'fileChange',
        id: 'file_1',
        changes: [
          {
            path: `${process.cwd()}\\README.md`,
            kind: { type: 'update', move_path: null },
            diff: 'mock diff',
          },
        ],
        status: 'completed',
      },
    });
    notify('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: {
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
        modelContextWindow: 128000,
      },
    });
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed', error: null },
    });
    turns.delete(turnId);
    return;
  }

  if (mode === 'failed') {
    notify('item/started', {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'commandExecution',
        id: 'call_failed',
        command: 'false',
        cwd: process.cwd(),
        status: 'inProgress',
        aggregatedOutput: null,
      },
    });
    notify('item/completed', {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: {
        type: 'commandExecution',
        id: 'call_failed',
        command: 'false',
        cwd: process.cwd(),
        status: 'failed',
        aggregatedOutput: 'boom',
        exitCode: 1,
      },
    });
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed', error: null },
    });
    turns.delete(turnId);
    return;
  }

  if (mode === 'long') {
    notify('item/started', {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'commandExecution',
        id: 'call_long',
        command: 'sleep',
        cwd: process.cwd(),
        status: 'inProgress',
        aggregatedOutput: null,
      },
    });
    return;
  }

  if (mode === 'approval') {
    const itemId = 'call_approval';
    notify('item/started', {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'commandExecution',
        id: itemId,
        command: 'echo approved',
        cwd: process.cwd(),
        status: 'inProgress',
        aggregatedOutput: null,
      },
    });

    const requestId = `srv_${nextServerRequest++}`;
    turns.get(turnId).pendingApproval = requestId;
    send({
      id: requestId,
      method: 'item/commandExecution/requestApproval',
      params: {
        kind: 'command',
        threadId,
        turnId,
        itemId,
        startedAtMs: Date.now(),
        command: 'echo approved',
        cwd: process.cwd(),
        reason: 'mock approval',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
    });
  }
}

function completeApproval(turnId, decision) {
  const turn = turns.get(turnId);
  if (!turn) return;
  const accepted = decision === 'accept';
  notify('item/completed', {
    threadId: turn.threadId,
    turnId,
    completedAtMs: Date.now(),
    item: {
      type: 'commandExecution',
      id: 'call_approval',
      command: 'echo approved',
      cwd: process.cwd(),
      status: accepted ? 'completed' : 'declined',
      aggregatedOutput: accepted ? 'approved' : 'denied',
      exitCode: accepted ? 0 : 1,
    },
  });
  notify('turn/completed', {
    threadId: turn.threadId,
    turn: { id: turnId, status: 'completed', error: null },
  });
  turns.delete(turnId);
}

function completeInterrupted(turnId) {
  const turn = turns.get(turnId);
  if (!turn) return;
  notify('turn/completed', {
    threadId: turn.threadId,
    turn: { id: turnId, status: 'interrupted', error: null },
  });
  turns.delete(turnId);
}

rl.on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);

  // Response from the client to a server request (approval).
  if (
    message.id !== undefined &&
    message.method === undefined &&
    message.result !== undefined
  ) {
    for (const [turnId, turn] of turns) {
      if (turn.pendingApproval === message.id) {
        completeApproval(turnId, message.result.decision);
        return;
      }
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        userAgent: 'codex-mock/0.165.0 (Windows; x86_64)',
        codexHome: process.env.CODEX_HOME ?? '',
        platformFamily: 'windows',
        platformOs: 'windows',
      });
      return;

    case 'windowsSandbox/readiness':
      respond(message.id, {
        status: process.env.MOCK_SANDBOX_STATUS ?? 'ready',
      });
      return;

    case 'thread/start':
      threadCounter += 1;
      currentThreadId =
        message.params.threadId ?? `thread_mock_${threadCounter}`;
      respond(message.id, {
        thread: {
          id: currentThreadId,
          modelProvider: message.params.modelProvider ?? 'mock',
          model: message.params.model ?? 'mock-model',
          cwd: message.params.cwd,
          status: { type: 'idle' },
          turns: [],
        },
        model: message.params.model ?? 'mock-model',
        modelProvider: message.params.modelProvider ?? 'mock',
        cwd: message.params.cwd,
        runtimeWorkspaceRoots: [message.params.cwd],
        approvalPolicy: message.params.approvalPolicy ?? 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite', writableRoots: [] },
        activePermissionProfile: { id: ':workspace', extends: null },
        reasoningEffort: null,
      });
      return;

    case 'turn/start': {
      turnCounter += 1;
      const turnId = `turn_mock_${turnCounter}`;
      const prompt = message.params.input?.[0]?.text ?? '';
      currentThreadId = message.params.threadId;
      respond(message.id, {
        turn: {
          id: turnId,
          rootTurnId: turnId,
          items: [],
          itemsView: 'notLoaded',
          status: 'inProgress',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      });
      // Run synchronously after the response so an immediate abort cannot
      // race the mock's turn bookkeeping. Response bytes are written first.
      beginTurn(turnId, prompt, currentThreadId);
      return;
    }

    case 'turn/interrupt': {
      respond(message.id, {});
      completeInterrupted(message.params.turnId);
      return;
    }

    case 'getAuthStatus':
      respond(message.id, {
        authMethod: null,
        authToken: null,
        requiresOpenaiAuth: false,
      });
      return;

    default:
      send({
        id: message.id,
        error: { code: -32601, message: `unsupported mock method: ${message.method}` },
      });
  }
});
