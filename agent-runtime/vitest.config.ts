import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .probe contains pinned runtimes and Codex-generated plugin files; never
    // treat those as project tests.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.probe/**',
    ],
  },
});
