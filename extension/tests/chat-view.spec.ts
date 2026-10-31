import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  activeTextEditor: undefined as unknown,
  openedExternal: [] as string[],
  config: new Map<string, unknown>(),
  messages: [] as Array<Record<string, unknown>>,
  receiveHandler: undefined as ((message: unknown) => void) | undefined,
  watchers: [] as Array<Record<string, unknown>>,
  executeCommand: async (): Promise<undefined> => undefined,
}));

vi.mock('vscode', () => {
  class Uri {
    constructor(
      public readonly fsPath: string,
      public readonly path: string
    ) {}

    static file(path: string): Uri {
      return new Uri(path, path);
    }

    static parse(path: string): Uri {
      return new Uri(path, path);
    }

    static joinPath(base: Uri, ...parts: string[]): Uri {
      const joined = [base.fsPath, ...parts].join('/');
      return new Uri(joined, joined);
    }

    toString(): string {
      return this.path;
    }
  }

  const disposable = { dispose(): void {} };

  return {
    Uri,
    StatusBarAlignment: { Left: 1 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    window: {
      get activeTextEditor(): unknown {
        return state.activeTextEditor;
      },
      onDidChangeActiveTextEditor: () => disposable,
      onDidChangeTextEditorSelection: () => disposable,
      registerWebviewViewProvider: () => disposable,
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
      showWarningMessage: async (): Promise<undefined> => undefined,
      showErrorMessage: async (): Promise<undefined> => undefined,
      showInformationMessage: async (): Promise<undefined> => undefined,
      showInputBox: async (): Promise<undefined> => undefined,
      withProgress: async (
        _options: unknown,
        task: () => Promise<unknown>
      ): Promise<unknown> => task(),
    },
    workspace: {
      get workspaceFolders(): typeof state.workspaceFolders {
        return state.workspaceFolders;
      },
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown): unknown =>
          state.config.has(key) ? state.config.get(key) : fallback,
        update: async (key: string, value: unknown): Promise<void> => {
          state.config.set(key, value);
        },
      }),
      onDidChangeWorkspaceFolders: () => disposable,
      createFileSystemWatcher: () => {
        const watcher = {
          onDidCreate: () => disposable,
          onDidChange: () => disposable,
          onDidDelete: () => disposable,
          dispose(): void {},
        };
        state.watchers.push(watcher);
        return watcher;
      },
      openTextDocument: async (): Promise<unknown> => ({
        uri: Uri.file('untitled'),
      }),
    },
    commands: {
      registerCommand: () => disposable,
      executeCommand: (command: unknown): Promise<undefined> => {
        void command;
        return state.executeCommand();
      },
    },
    env: {
      openExternal: async (uri: Uri): Promise<boolean> => {
        state.openedExternal.push(uri.path);
        return true;
      },
    },
  };
});

import { ChatViewProvider } from '../src/chat-view';

interface FakeWebview {
  options: unknown;
  html: string;
  cspSource: string;
  postMessage(message: unknown): Promise<boolean>;
  onDidReceiveMessage(
    callback: (message: unknown) => void
  ): { dispose(): void };
  asWebviewUri(uri: unknown): unknown;
}

function createWebview(): FakeWebview {
  return {
    options: undefined,
    html: '',
    cspSource: 'vscode-resource://agentbox',
    postMessage: async (message: unknown): Promise<boolean> => {
      state.messages.push(message as Record<string, unknown>);
      return true;
    },
    onDidReceiveMessage: (callback) => {
      state.receiveHandler = callback;
      return { dispose(): void {} };
    },
    asWebviewUri: (uri) => uri,
  };
}

const context = {
  subscriptions: [],
  extensionUri: { fsPath: 'D:/ext', path: 'D:/ext' },
  globalStorageUri: { fsPath: 'D:/state' },
};

let workspaceRoot: string;
let provider: ChatViewProvider | undefined;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'agentbox-chat-'));
  state.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
  state.activeTextEditor = undefined;
  state.openedExternal = [];
  state.config.clear();
  state.config.set('runtime', 'fake');
  state.messages = [];
  state.receiveHandler = undefined;
  state.watchers = [];
});

afterEach(() => {
  provider?.dispose();
  provider = undefined;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for chat message');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function resolveView(externalBusy?: () => boolean): FakeWebview {
  const webview = createWebview();
  provider = new ChatViewProvider(
    context as never,
    context.extensionUri as never,
    externalBusy
  );
  provider.resolveWebviewView({
    webview,
    onDidDispose: () => ({ dispose(): void {} }),
  } as never);
  return webview;
}

describe('ChatViewProvider', () => {
  it('renders a locked-down HTML shell with local resources', () => {
    const webview = resolveView();

    expect(webview.html).toContain("default-src 'none'");
    expect(webview.html).toContain("script-src 'nonce-");
    expect(webview.html).toContain('dist/webview.js');
    expect(webview.html).toContain('media/chat.css');
    expect(webview.html).toContain('id="timeline"');
    expect(webview.html).toContain('id="timeline-toggle"');
    expect(webview.html).toContain('id="timeline-tokens"');
    expect(webview.html).toContain('id="question-nav"');
    expect(webview.html).toContain('id="question-tooltip"');
    expect(webview.html).toContain('id="lane-thinking"');
    expect(webview.html).toContain('id="lane-generation"');
    expect(webview.html).toContain('id="lane-tool"');
    expect(webview.html).not.toContain('id="lane-approval"');
    expect(webview.html).toContain('id="settings-panel"');
    expect(webview.html).toContain('id="settings-scrim"');
    expect(webview.html).toContain('id="toggle-file"');
    expect(webview.html).toContain('id="submit"');
    expect(webview.html).toContain('id="setting-approval"');
    expect(webview.html).not.toContain('type="checkbox"');
    expect(webview.html).not.toMatch(/https?:\/\//i);
  });

  it('posts runtime state and active context when the webview is ready', () => {
    resolveView();

    state.receiveHandler?.({ type: 'ready' });

    expect(state.messages).toContainEqual({
      type: 'state',
      busy: false,
      runtime: 'fake',
      model: 'fake',
      provider: undefined,
      workspaceRoot,
    });
    expect(state.messages).toContainEqual({ type: 'context', context: {} });
  });

  it('reports the active file as workspace-relative context', () => {
    const file = join(workspaceRoot, 'src', 'a.ts');
    state.activeTextEditor = {
      document: {
        uri: { scheme: 'file', fsPath: file },
        languageId: 'typescript',
        getText: () => 'const a = 1;',
      },
      selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
    };
    resolveView();

    state.receiveHandler?.({ type: 'ready' });

    expect(state.messages).toContainEqual({
      type: 'context',
      context: { file: 'src/a.ts' },
    });
  });

  it('rejects a prompt without a workspace', () => {
    state.workspaceFolders = undefined;
    resolveView();

    state.receiveHandler?.({
      type: 'prompt',
      text: 'hi',
      includeFile: false,
      includeSelection: false,
    });

    expect(state.messages).toContainEqual({
      type: 'error',
      message: '请先打开一个工作区文件夹。',
    });
  });

  it('refuses a prompt while the fallback controller is busy', () => {
    resolveView(() => true);

    state.receiveHandler?.({
      type: 'prompt',
      text: 'hi',
      includeFile: false,
      includeSelection: false,
    });

    expect(state.messages).toContainEqual({
      type: 'error',
      message: '另一个 AgentBox turn 正在运行，请先停止它。',
    });
  });

  it('runs a fake turn end-to-end with an inline approval', async () => {
    resolveView();

    state.receiveHandler?.({
      type: 'prompt',
      text: 'demo',
      includeFile: false,
      includeSelection: false,
    });

    await waitFor(() =>
      state.messages.some((message) => message.type === 'approval.request')
    );
    const request = state.messages.find(
      (message) => message.type === 'approval.request'
    ) as { id: string };

    state.receiveHandler?.({
      type: 'approval.response',
      id: request.id,
      decision: 'deny',
    });

    await waitFor(() =>
      state.messages.some((message) => message.type === 'turn.end')
    );

    expect(
      state.messages.some((message) => message.type === 'assistant.delta')
    ).toBe(true);
    expect(
      state.messages.some((message) => message.type === 'approval.resolved')
    ).toBe(true);
    expect(
      state.messages.some(
        (message) => message.type === 'tool.start' && message.name === 'read_file'
      )
    ).toBe(true);
    expect(
      state.messages.some((message) => message.type === 'file.changed')
    ).toBe(true);

    const busy = state.messages.filter((message) => message.type === 'busy');
    expect(busy[busy.length - 1]).toEqual({ type: 'busy', busy: false });
  });

  it('opens the in-panel settings overlay', async () => {
    resolveView();

    await provider?.openSettings();

    expect(state.messages).toContainEqual({ type: 'settings.open' });
  });

  it('returns current settings to the panel', () => {
    resolveView();

    state.receiveHandler?.({ type: 'settings.request' });

    expect(state.messages).toContainEqual({
      type: 'settings',
      values: {
        runtime: 'fake',
        taskProfile: 'code',
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        approvalPolicy: 'on-request',
      },
    });
  });

  it('saves settings and resets the session', async () => {
    resolveView();

    state.receiveHandler?.({
      type: 'settings.save',
      values: {
        runtime: 'codex',
        taskProfile: 'simple',
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        approvalPolicy: 'untrusted',
      },
    });

    await waitFor(() =>
      state.messages.some(
        (message) =>
          message.type === 'log' &&
          String(message.text).includes('设置已保存')
      )
    );

    expect(state.config.get('runtime')).toBe('codex');
    expect(state.config.get('taskProfile')).toBe('simple');
    expect(state.config.get('codex.approvalPolicy')).toBe('untrusted');
    expect(state.messages).toContainEqual({ type: 'clear' });
    expect(state.messages).toContainEqual({ type: 'settings.saved' });
    expect(state.messages).toContainEqual(
      expect.objectContaining({ type: 'state', runtime: 'codex' })
    );
  });

  it('rejects invalid settings values', async () => {
    resolveView();

    state.receiveHandler?.({
      type: 'settings.save',
      values: {
        runtime: 'not-a-runtime',
        taskProfile: 'code',
        provider: '',
        model: '',
        baseUrl: '',
        approvalPolicy: 'on-request',
      },
    });

    await waitFor(() =>
      state.messages.some((message) => message.type === 'settings.error')
    );
    expect(state.config.get('runtime')).toBe('fake');
  });

  it('opens http(s) links through the extension host', async () => {
    resolveView();

    state.receiveHandler?.({
      type: 'openExternal',
      url: 'https://example.com/docs',
    });
    await Promise.resolve();

    expect(state.openedExternal).toEqual(['https://example.com/docs']);
  });

  it('ignores non-http external URLs', async () => {
    resolveView();

    state.receiveHandler?.({
      type: 'openExternal',
      url: 'file:///C:/Windows/System32/calc.exe',
    });
    await Promise.resolve();

    expect(state.openedExternal).toEqual([]);
  });
});
