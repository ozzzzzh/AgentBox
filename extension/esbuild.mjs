import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile: resolve(root, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // VS Code 1.85 extension host runs Node 18.
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});

await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, 'src/webview/chat.ts')],
  outfile: resolve(root, 'dist/webview.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
});
