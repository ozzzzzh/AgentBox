import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const requireFromTest = createRequire(import.meta.url);

const bundlePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../dist/extension.js'
);

type LoadFn = (
  request: string,
  parent: unknown,
  isMain: boolean
) => unknown;

interface FakeCommand {
  dispose(): void;
}

function createFakeVscode() {
  const commands = new Map<string, (...args: unknown[]) => unknown>();

  const fakeVscode = {
    commands: {
      registerCommand: (
        name: string,
        callback: (...args: unknown[]) => unknown
      ): FakeCommand => {
        commands.set(name, callback);
        return { dispose() {} };
      },
      executeCommand: async (): Promise<void> => undefined,
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: () => ({
        append(): void {},
        appendLine(): void {},
        show(): void {},
        dispose(): void {},
      }),
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        show(): void {},
        hide(): void {},
        dispose(): void {},
      }),
      registerWebviewViewProvider: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      onDidChangeTextEditorSelection: () => ({ dispose() {} }),
      withProgress: async (
        _options: unknown,
        task: () => Promise<unknown>
      ): Promise<unknown> => task(),
      showWarningMessage: async (): Promise<undefined> => undefined,
      showErrorMessage: async (): Promise<undefined> => undefined,
      showInformationMessage: async (): Promise<undefined> => undefined,
      showInputBox: async (): Promise<undefined> => undefined,
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({
        get: (_key: string, fallback?: unknown) => fallback,
      }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      createFileSystemWatcher: () => ({
        onDidCreate: () => ({ dispose() {} }),
        onDidChange: () => ({ dispose() {} }),
        onDidDelete: () => ({ dispose() {} }),
        dispose(): void {},
      }),
    },
    env: {
      openExternal: async (): Promise<boolean> => true,
    },
    StatusBarAlignment: { Left: 1 },
  };

  return { fakeVscode, commands };
}

describe('bundled extension', () => {
  it.skipIf(!existsSync(bundlePath))(
    'loads without vscode and registers commands',
    async () => {
      const { fakeVscode, commands } = createFakeVscode();
      const moduleApi = requireFromTest('node:module') as { _load: LoadFn };
      const originalLoad = moduleApi._load;

      moduleApi._load = function (
        request: string,
        parent: unknown,
        isMain: boolean
      ): unknown {
        if (request === 'vscode') return fakeVscode;
        return originalLoad.call(this, request, parent, isMain);
      };

      delete requireFromTest.cache[bundlePath];

      try {
        const bundle = requireFromTest(bundlePath) as {
          activate(context: unknown): void;
          deactivate(): Promise<void>;
        };
        const subscriptions: FakeCommand[] = [];

        bundle.activate({ subscriptions });

        expect([...commands.keys()].sort()).toEqual([
          'agentbox.cancelTurn',
          'agentbox.clearApiKey',
          'agentbox.configure',
          'agentbox.focusSidebar',
          'agentbox.openChat',
          'agentbox.openInEditor',
          'agentbox.restartRuntime',
          'agentbox.runTurn',
          'agentbox.setApiKey',
          'agentbox.showOutput',
        ]);
        expect(subscriptions.length).toBeGreaterThanOrEqual(3);

        await bundle.deactivate();
      } finally {
        moduleApi._load = originalLoad;
        delete requireFromTest.cache[bundlePath];
      }
    }
  );
});
