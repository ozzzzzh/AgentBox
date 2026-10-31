'use strict';

const { spawn } = require('node:child_process');

const mode = process.argv[2] || 'lines';

switch (mode) {
  case 'lines':
    process.stdout.write('alpha\nbet');
    setTimeout(() => process.stdout.write('a\r\ngamma'), 15);
    setTimeout(() => process.stdout.write('\r\npartial'), 30);
    break;

  case 'long':
    process.stdout.write('x'.repeat(1000));
    break;

  case 'echo':
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      process.stdout.write(`echo:${chunk}`);
    });
    break;

  case 'exit':
    process.stderr.write('oops\n');
    process.exit(Number(process.argv[3] || 3));
    break;

  case 'env':
    process.stdout.write(
      `${JSON.stringify({
        PATH: process.env.PATH,
        MODEL_API_KEY: process.env.MODEL_API_KEY,
        CUSTOM: process.env.CUSTOM,
      })}\n`
    );
    break;

  case 'tree': {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore', windowsHide: true }
    );
    process.stdout.write(`grandchild:${child.pid}\n`);
    setInterval(() => {}, 1000);
    break;
  }

  case 'hang':
    setInterval(() => {}, 1000);
    break;

  default:
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(2);
}
