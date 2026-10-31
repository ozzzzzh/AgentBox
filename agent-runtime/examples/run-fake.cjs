'use strict';

/**
 * Runnable consumer smoke: `npm run example:fake`.
 * Uses the built package entry (`dist/testing`), not source imports.
 */
const { FakeRuntime } = require('../dist/testing/index.js');

(async () => {
  const runtime = new FakeRuntime({
    defaultScript: [
      { type: 'text', text: 'hello from FakeRuntime\n' },
      {
        type: 'tool',
        callId: 'c1',
        name: 'read_file',
        args: { path: 'README.md' },
        ok: true,
        result: 'fake content',
      },
    ],
  });

  let resolveEnd;
  const ended = new Promise((resolve) => {
    resolveEnd = resolve;
  });

  runtime.onEvent((event) => {
    console.log(event.type);
    if (event.type === 'turn.end') resolveEnd();
  });

  await runtime.start();
  const handle = await runtime.startTurn({
    prompt: 'hello',
    workspaceRoot: process.cwd(),
    limits: { turnTimeoutMs: 5_000 },
  });
  await ended;
  await runtime.stop();
  console.log('done', handle.turnId);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
