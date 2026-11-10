import { randomBytes } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import type {
  HostToWebview,
  SessionEvent,
  SessionSummary,
  SettingsValues,
  WebviewToHost,
} from './chat-protocol';
import { buildContextText } from './context';
import { RuntimeController } from './controller';
import { evaluateApprovalPolicy } from './file-policy';
import { ToolLoopDetector } from './loop-detector';
import {
  createAgentRuntime,
  readDenyWritePatterns,
  readLoopDetectionOptions,
  readModelSettings,
  readSkillGroups,
  readSkillSettings,
  requestSkillGroups,
  secretKey,
  skillServerTokenKey,
} from './runtime-host';
import { WebviewTurnUi } from './ui/webview-ui';
import { buildSkillCatalog, type SkillCatalogItem } from './skills/catalog';
import type { SkillUsage } from './skills/model';
import {
  buildMentionedSkillContext,
  extractSkillMentions,
  type MentionCandidate,
} from './skills/mentions';
import { readLocalSkills, readRemoteSkills, resolveLocalSkillsDir } from './skills/store';

const IGNORED_WATCH_SEGMENTS = new Set([
  '.git',
  '.probe',
  '.vscode-test',
  'node_modules',
  'dist',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Workspace-relative POSIX path, or undefined when outside the workspace. */
function toWorkspacePath(
  root: string,
  absolute: string
): string | undefined {
  const rel = relative(root, absolute);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return undefined;
  }
  return rel.split(sep).join('/');
}

function isIgnoredWatchPath(path: string): boolean {
  return path
    .split('/')
    .some((segment) => IGNORED_WATCH_SEGMENTS.has(segment));
}

const MAX_LOG_CHARS = 20_000;
const MAX_REASONING_STORE_CHARS = 50_000;

interface ToolDetail {
  name: string;
  args: unknown;
  result: string;
  ok: boolean | null;
}

interface ChatSession {
  id: string;
  title: string;
  controller?: RuntimeController;
  ui?: WebviewTurnUi;
  root?: string;
  signature?: string;
  changedThisTurn: Set<string>;
  /** Session-scoped UI events, replayed into each webview surface. */
  events: SessionEvent[];
  skillUsage?: SkillUsage[];
  toolDetails: Map<string, ToolDetail>;
  /** Current reasoning summary buffer; only the final text is persisted. */
  reasoningBuffer: string;
  reasoningPending: string;
  reasoningKind?: 'summary' | 'raw';
  reasoningTimer?: ReturnType<typeof setTimeout>;
}

interface ChatSurface {
  id: number;
  webview: vscode.Webview;
  post(message: HostToWebview): void;
  dispose(): void;
}

function truncateTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= 24
    ? normalized
    : `${normalized.slice(0, 24)}…`;
}

function stringifyForLog(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length <= MAX_LOG_CHARS
    ? text
    : `${text.slice(0, MAX_LOG_CHARS)}\n… (truncated, ${text.length} chars)`;
}

export class ChatViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private surfaces: ChatSurface[] = [];
  private nextSurfaceId = 1;
  private panel: vscode.WebviewPanel | undefined;
  private sessions: ChatSession[] = [];
  private activeSessionId = '';
  private runtimeId = 'codex';
  private modelLabel = '';
  private providerLabel: string | undefined;
  private disposed = false;
  private watcher: vscode.FileSystemWatcher | undefined;
  private watcherRoot: string | undefined;
  private watcherListeners: vscode.Disposable[] = [];
  private startingSession = false;
  private cancelRequested = false;
  private pendingSettingsOpen = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
    private readonly isExternalBusy: () => boolean = () => false
  ) {
    this.output = vscode.window.createOutputChannel('AgentBox Chat');
    this.refreshLabels();
    this.sessions = [this.createSession()];
    this.activeSessionId = this.sessions[0]!.id;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.postContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.postContext()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        const root = this.currentRoot();
        if (root !== this.activeSession.root) {
          void this.reset();
        }
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const surface = this.attachSurface(view.webview);
    view.onDidDispose(() => surface.dispose());
  }

  /** Open the same chat in an editor tab so it can be dragged/split like a file. */
  async openInEditor(): Promise<void> {
    if (this.panel !== undefined) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'agentbox.chat.panel',
      'AgentBox',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'media'),
          vscode.Uri.joinPath(this.extensionUri, 'dist'),
        ],
      }
    );
    this.panel = panel;
    const surface = this.attachSurface(panel.webview);
    panel.onDidDispose(() => {
      surface.dispose();
      this.panel = undefined;
    });
  }

  private attachSurface(webview: vscode.Webview): ChatSurface {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
      ],
    };
    webview.html = this.renderHtml(webview);

    const surface: ChatSurface = {
      id: this.nextSurfaceId++,
      webview,
      post: (message) => {
        try {
          void webview.postMessage(message);
        } catch {
          // The surface may be disposed between events.
        }
      },
      dispose: () => {
        const index = this.surfaces.indexOf(surface);
        if (index >= 0) this.surfaces.splice(index, 1);
        subscription.dispose();
        if (this.surfaces.length === 0) {
          void this.disposeAllSessions();
        }
      },
    };
    const subscription = webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(surface, message);
    });
    this.surfaces.push(surface);
    return surface;
  }

  dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.disposeWatcher();
    this.panel?.dispose();
    this.panel = undefined;
    this.surfaces.length = 0;
    void this.disposeAllSessions();
    this.output.dispose();
  }

  private createSession(): ChatSession {
    return {
      id: `s${randomBytes(6).toString('hex')}`,
      title: '新会话',
      changedThisTurn: new Set<string>(),
      events: [],
      toolDetails: new Map(),
      reasoningBuffer: '',
      reasoningPending: '',
    };
  }

  private get activeSession(): ChatSession {
    return (
      this.sessions.find((session) => session.id === this.activeSessionId) ??
      this.sessions[0]!
    );
  }

  /** Drop all runtimes and start a fresh session in the panel. */
  async reset(): Promise<void> {
    await this.disposeAllSessions();
    this.sessions = [this.createSession()];
    this.activeSessionId = this.sessions[0]!.id;
    this.post({ type: 'clear' });
    this.postSessions();
    this.postSessionLoad(this.activeSession);
    this.postSkills();
    this.postState();
    this.postContext();
  }

  get busy(): boolean {
    return (
      this.startingSession ||
      this.sessions.some((session) => session.controller?.busy === true)
    );
  }

  async cancel(): Promise<void> {
    const controller = this.activeSession.controller;
    if (controller === undefined) {
      // Runtime/sandbox startup can take seconds; honor Stop once it is ready.
      if (this.startingSession) this.cancelRequested = true;
      return;
    }
    await controller.cancel();
  }

  showOutput(): void {
    this.output.show(true);
  }

  private refreshLabels(): void {
    const runtimeId = vscode.workspace
      .getConfiguration('agentbox')
      .get<string>('runtime', 'codex');
    this.runtimeId = runtimeId;
    if (runtimeId === 'codex') {
      const settings = readModelSettings();
      this.modelLabel = settings.model;
      this.providerLabel = settings.provider;
    } else {
      this.modelLabel = 'fake';
      this.providerLabel = undefined;
    }
  }

  /**
   * Open the in-panel settings overlay. The webview asks for values and saves
   * them back through postMessage; no VS Code settings page is opened.
   */
  async openSettings(): Promise<void> {
    this.pendingSettingsOpen = true;
    try {
      await vscode.commands.executeCommand('agentbox.chat.focus');
    } catch {
      // Focus is best effort; the message below still opens the panel.
    }
    this.post({ type: 'settings.open' });
  }

  private async readSettingsValues(): Promise<SettingsValues> {
    const config = vscode.workspace.getConfiguration('agentbox');
    const provider = config.get<string>('codex.provider', 'deepseek');
    const apiKey = await this.context.secrets.get(secretKey(provider));
    const skillToken = await this.context.secrets.get(skillServerTokenKey());
    const skillSettings = readSkillSettings();
    return {
      runtime: config.get<string>('runtime', 'codex'),
      taskProfile: config.get<string>('taskProfile', 'code'),
      provider,
      model: config.get<string>('codex.model', 'deepseek-flash'),
      baseUrl: config.get<string>('codex.baseUrl', 'https://api.deepseek.com'),
      approvalPolicy: config.get<string>(
        'codex.approvalPolicy',
        'on-request'
      ),
      reasoningEffort: config.get<string>('codex.reasoningEffort', 'medium'),
      apiKeyConfigured:
        apiKey !== undefined && apiKey.trim() !== '',
      codexCommand: config.get<string>('codex.command', 'codex'),
      extraInstructions: config.get<string>('codex.extraInstructions', ''),
      skillServerUrl: skillSettings.serverUrl,
      skillServerTokenConfigured:
        skillToken !== undefined && skillToken.trim() !== '',
      skillsAutoSync: skillSettings.autoSync,
      skillsRequiredMissing: skillSettings.requiredMissing,
      skillsLocalDir: skillSettings.localDir,
    };
  }

  private async saveSettings(raw: unknown): Promise<void> {
    if (!isRecord(raw)) {
      this.post({ type: 'settings.error', message: '设置格式无效。' });
      return;
    }
    if (this.busy) {
      this.post({
        type: 'settings.error',
        message: '请先停止正在运行的 turn 再修改设置。',
      });
      return;
    }

    const runtime =
      raw.runtime === 'codex' || raw.runtime === 'fake'
        ? raw.runtime
        : undefined;
    const taskProfile =
      raw.taskProfile === 'simple' ||
      raw.taskProfile === 'research' ||
      raw.taskProfile === 'code'
        ? raw.taskProfile
        : undefined;
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
    const approvalPolicy =
      raw.approvalPolicy === 'untrusted' ||
      raw.approvalPolicy === 'on-request' ||
      raw.approvalPolicy === 'never'
        ? raw.approvalPolicy
        : undefined;
    const reasoningEffort =
      raw.reasoningEffort === 'low' ||
      raw.reasoningEffort === 'medium' ||
      raw.reasoningEffort === 'high'
        ? raw.reasoningEffort
        : undefined;
    const codexCommand =
      typeof raw.codexCommand === 'string' && raw.codexCommand.trim() !== ''
        ? raw.codexCommand.trim()
        : 'codex';
    const extraInstructions =
      typeof raw.extraInstructions === 'string' ? raw.extraInstructions : '';
    const skillServerUrl =
      typeof raw.skillServerUrl === 'string'
        ? raw.skillServerUrl.trim()
        : '';
    const skillsAutoSync = raw.skillsAutoSync === true;
    const skillsRequiredMissing =
      raw.skillsRequiredMissing === 'block' ? 'block' : 'warn';
    const skillsLocalDir =
      typeof raw.skillsLocalDir === 'string' ? raw.skillsLocalDir.trim() : '';
    const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
    const skillServerToken =
      typeof raw.skillServerToken === 'string'
        ? raw.skillServerToken.trim()
        : '';
    const clearApiKey = raw.clearApiKey === true;
    const clearSkillServerToken = raw.clearSkillServerToken === true;
    if (
      runtime === undefined ||
      taskProfile === undefined ||
      approvalPolicy === undefined ||
      reasoningEffort === undefined
    ) {
      this.post({
        type: 'settings.error',
        message: '设置值无效，请检查后重试。',
      });
      return;
    }
    if (
      runtime === 'codex' &&
      (provider === '' || model === '' || baseUrl === '')
    ) {
      this.post({
        type: 'settings.error',
        message: 'codex runtime 需要 provider、模型和 Base URL。',
      });
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    const target =
      folders !== undefined && folders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    const config = vscode.workspace.getConfiguration('agentbox');

    await config.update('runtime', runtime, target);
    await config.update('taskProfile', taskProfile, target);
    await config.update('codex.provider', provider, target);
    await config.update('codex.model', model, target);
    await config.update('codex.baseUrl', baseUrl, target);
    await config.update('codex.approvalPolicy', approvalPolicy, target);
    await config.update('codex.reasoningEffort', reasoningEffort, target);
    await config.update('codex.command', codexCommand, target);
    await config.update('codex.extraInstructions', extraInstructions, target);
    await config.update('skills.serverUrl', skillServerUrl, target);
    await config.update('skills.autoSync', skillsAutoSync, target);
    await config.update('skills.requiredMissing', skillsRequiredMissing, target);
    await config.update('skills.localDir', skillsLocalDir, target);

    if (clearApiKey) {
      await this.context.secrets.delete(secretKey(provider));
    } else if (apiKey !== '') {
      await this.context.secrets.store(secretKey(provider), apiKey);
    }
    if (clearSkillServerToken) {
      await this.context.secrets.delete(skillServerTokenKey());
    } else if (skillServerToken !== '') {
      await this.context.secrets.store(skillServerTokenKey(), skillServerToken);
    }

    this.output.appendLine(
      `[config] runtime=${runtime} profile=${taskProfile} provider=${provider} ` +
        `model=${model} approval=${approvalPolicy} effort=${reasoningEffort} ` +
        `skills=${skillServerUrl === '' ? 'off' : skillServerUrl}`
    );

    this.refreshLabels();
    await this.reset();
    this.post({
      type: 'settings',
      values: await this.readSettingsValues(),
    });
    this.post({ type: 'settings.saved' });
    this.post({ type: 'log', text: '设置已保存，会话已重置。' });
  }

  private currentRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async disposeSession(session: ChatSession): Promise<void> {
    const current = session.controller;
    session.controller = undefined;
    session.signature = undefined;
    await current?.dispose();
    session.ui?.dispose();
    session.ui = undefined;
    session.root = undefined;
    session.changedThisTurn.clear();
    if (session.reasoningTimer !== undefined) {
      clearTimeout(session.reasoningTimer);
      session.reasoningTimer = undefined;
    }
    session.reasoningBuffer = '';
    session.reasoningPending = '';
    session.reasoningKind = undefined;
  }

  private async disposeAllSessions(): Promise<void> {
    await Promise.all(this.sessions.map((session) => this.disposeSession(session)));
    this.disposeWatcher();
  }

  private async getSession(
    session: ChatSession,
    root: string
  ): Promise<RuntimeController> {
    const bundle = await createAgentRuntime(this.context, root);
    this.runtimeId = bundle.runtimeId;
    this.modelLabel = bundle.modelLabel;
    this.providerLabel = bundle.providerLabel;

    if (
      session.controller !== undefined &&
      session.root === root &&
      session.signature === bundle.signature
    ) {
      return session.controller;
    }

    await this.disposeSession(session);
    const webviewUi = new WebviewTurnUi((message) =>
      this.emit(session, message)
    );
    const loopOptions = readLoopDetectionOptions();
    const next = new RuntimeController({
      runtime: bundle.runtime,
      workspaceRoot: root,
      limits: bundle.limits,
      ui: webviewUi,
      approvalPolicy: (prompt) =>
        evaluateApprovalPolicy(prompt, root, readDenyWritePatterns()),
      ...(loopOptions !== undefined
        ? { loopDetector: new ToolLoopDetector(loopOptions) }
        : {}),
    });

    try {
      await next.start();
    } catch (error) {
      webviewUi.dispose();
      throw error;
    }

    session.controller = next;
    session.ui = webviewUi;
    session.root = root;
    session.signature = bundle.signature;
    session.skillUsage = bundle.skillUsage ?? [];
    if (bundle.projectInstructionsPath !== undefined) {
      this.output.appendLine(
        `[project] ${bundle.projectInstructionsPath}${
          bundle.projectInstructionsTruncated === true ? ' (truncated)' : ''
        }`
      );
    }
    for (const warning of bundle.skillWarnings ?? []) {
      this.output.appendLine(`[skill] ${warning}`);
    }
    if ((bundle.skillUsage ?? []).length > 0) {
      this.output.appendLine(
        `[skill] injected: ${bundle.skillUsage!
          .map((item) => `${item.id}@${item.version} (${item.source})`)
          .join(', ')}`
      );
    }
    this.ensureWatcher(root);
    this.postSkills(session);
    this.postSessions();
    this.postState();
    return next;
  }

  private sessionsMessage(): Extract<HostToWebview, { type: 'sessions' }> {
    const sessions: SessionSummary[] = this.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      busy: session.controller?.busy === true,
    }));
    return {
      type: 'sessions',
      sessions,
      activeId: this.activeSessionId,
    };
  }

  private postSessions(): void {
    this.post(this.sessionsMessage());
  }

  private postSessionsTo(surface: ChatSurface): void {
    surface.post(this.sessionsMessage());
  }

  private postSessionLoad(session: ChatSession): void {
    this.post({
      type: 'session.load',
      id: session.id,
      events: session.events,
    });
  }

  private postSessionLoadTo(surface: ChatSurface, session: ChatSession): void {
    surface.post({
      type: 'session.load',
      id: session.id,
      events: session.events,
    });
  }

  private postSkills(session: ChatSession = this.activeSession): void {
    this.post({ type: 'skills', skills: session.skillUsage ?? [] });
  }

  private postSkillsTo(
    surface: ChatSurface,
    session: ChatSession = this.activeSession
  ): void {
    surface.post({ type: 'skills', skills: session.skillUsage ?? [] });
  }

  private async postSkillGroups(): Promise<void> {
    try {
      this.post({
        type: 'skills.groups',
        groups: await readSkillGroups(this.context),
      });
    } catch (error) {
      this.output.appendLine(
        `[skill] group list failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private readSkillCatalog(): SkillCatalogItem[] {
    const settings = readSkillSettings();
    const local = readLocalSkills(
      resolveLocalSkillsDir(settings.localDir)
    ).items.map((item) => item.skill);
    const remote =
      settings.serverUrl === ''
        ? []
        : readRemoteSkills(
            this.context.globalStorageUri.fsPath,
            settings.serverUrl
          ).items.map((item) => ({
            skill: item.skill,
            required: item.required,
            ...(item.groups === undefined ? {} : { groups: item.groups }),
          }));
    return buildSkillCatalog({
      local,
      remote,
      enabledIds: settings.enabled,
      disabledIds: settings.disabled,
    });
  }

  private readSkillPackages(): MentionCandidate[] {
    const settings = readSkillSettings();
    const local = readLocalSkills(
      resolveLocalSkillsDir(settings.localDir)
    ).items.map<MentionCandidate>((item) => ({
      skill: item.skill,
      source: 'local',
    }));
    const remote =
      settings.serverUrl === ''
        ? []
        : readRemoteSkills(
            this.context.globalStorageUri.fsPath,
            settings.serverUrl
          ).items.map<MentionCandidate>((item) => ({
            skill: item.skill,
            source: 'remote',
          }));
    const byId = new Map<string, MentionCandidate>();
    for (const item of [...remote, ...local]) {
      if (!byId.has(item.skill.manifest.id)) {
        byId.set(item.skill.manifest.id, item);
      }
    }
    return [...byId.values()];
  }

  private async toggleSkill(id: string, enabled: boolean): Promise<void> {
    const item = this.readSkillCatalog().find((entry) => entry.id === id);
    if (item === undefined || item.required) return;
    const settings = readSkillSettings();
    const enabledIds = new Set(settings.enabled);
    const disabledIds = new Set(settings.disabled);
    if (enabled) {
      enabledIds.add(id);
      disabledIds.delete(id);
    } else {
      enabledIds.delete(id);
      disabledIds.add(id);
    }
    const folders = vscode.workspace.workspaceFolders;
    const target =
      folders !== undefined && folders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    const config = vscode.workspace.getConfiguration('agentbox');
    await config.update('skills.enabled', [...enabledIds], target);
    await config.update('skills.disabled', [...disabledIds], target);
    this.post({ type: 'skills.catalog', items: this.readSkillCatalog() });
    this.post({
      type: 'log',
      text: `skill ${id} 已${enabled ? '启用' : '停用'}，下一条 prompt 生效。`,
    });
  }

  private async handleMessage(
    surface: ChatSurface,
    raw: unknown
  ): Promise<void> {
    if (!isRecord(raw) || typeof raw.type !== 'string') return;

    try {
      switch (raw.type as WebviewToHost['type']) {
        case 'ready':
          this.postSessionsTo(surface);
          this.postSessionLoadTo(surface, this.activeSession);
          this.postSkillsTo(surface);
          surface.post({
            type: 'skills.catalog',
            items: this.readSkillCatalog(),
          });
          void this.postSkillGroups();
          this.postState();
          this.postContext();
          if (this.pendingSettingsOpen) {
            this.pendingSettingsOpen = false;
            this.post({ type: 'settings.open' });
          }
          return;

        case 'openEditor':
          await this.openInEditor();
          return;

        case 'prompt': {
          const text = typeof raw.text === 'string' ? raw.text.trim() : '';
          if (text === '') return;
          const root = this.currentRoot();
          if (root === undefined) {
            this.post({ type: 'error', message: '请先打开一个工作区文件夹。' });
            return;
          }
          if (this.isExternalBusy()) {
            this.post({
              type: 'error',
              message: '另一个 AgentBox turn 正在运行，请先停止它。',
            });
            return;
          }
          if (this.busy) {
            this.post({
              type: 'error',
              message: '另一个会话正在运行，请先停止它。',
            });
            return;
          }
          const chatSession = this.activeSession;
          const includeFile = raw.includeFile === true;
          const includeSelection = raw.includeSelection === true;
          this.emit(chatSession, { type: 'user.message', text });
          this.startingSession = true;
          this.cancelRequested = false;
          let controller: RuntimeController;
          try {
            controller = await this.getSession(chatSession, root);
          } finally {
            this.startingSession = false;
          }
          if (this.cancelRequested) {
            this.cancelRequested = false;
            this.post({ type: 'busy', busy: false });
            return;
          }
          if (chatSession.title === '新会话') {
            chatSession.title = truncateTitle(text);
            this.postSessions();
          }
          const mentionedIds = new Set(extractSkillMentions(text));
          const mentioned = this.readSkillPackages().filter((candidate) =>
            mentionedIds.has(candidate.skill.manifest.id)
          );
          const mentionContext =
            mentionedIds.size > 0
              ? buildMentionedSkillContext({
                  skills: mentioned,
                  alreadyInjected: chatSession.skillUsage ?? [],
                })
              : { text: '', usage: [], warnings: [] };
          for (const warning of mentionContext.warnings) {
            this.output.appendLine(`[skill] ${warning}`);
          }
          const contextParts = [
            this.buildActiveContext(root, includeFile, includeSelection),
            mentionContext.text,
          ].filter(
            (part): part is string =>
              typeof part === 'string' && part.trim() !== ''
          );
          const context =
            contextParts.length > 0 ? contextParts.join('\n\n') : undefined;
          const metadataSkills = [
            ...(chatSession.skillUsage ?? []),
            ...mentionContext.usage,
          ].filter(
            (item, index, list) =>
              list.findIndex((candidate) => candidate.id === item.id) === index
          );
          await controller.runTurn(
            text,
            context,
            metadataSkills.length > 0 ? { skills: metadataSkills } : undefined
          );
          return;
        }

        case 'cancel':
          await this.activeSession.controller?.cancel();
          return;

        case 'approval.response': {
          const id = typeof raw.id === 'string' ? raw.id : '';
          const decision = raw.decision === 'allow' ? 'allow' : 'deny';
          if (id !== '') this.activeSession.ui?.resolveApproval(id, decision);
          return;
        }

        case 'openFile':
          if (typeof raw.path === 'string') {
            await this.openWorkspaceFile(raw.path);
          }
          return;

        case 'openToolDetails':
          if (typeof raw.callId === 'string') {
            await this.openToolDetails(this.activeSession, raw.callId);
          }
          return;

        case 'openExternal':
          if (
            typeof raw.url === 'string' &&
            /^https?:\/\//i.test(raw.url)
          ) {
            await vscode.env.openExternal(vscode.Uri.parse(raw.url));
          }
          return;

        case 'showLog':
          this.showOutput();
          return;

        case 'settings.request':
          this.pendingSettingsOpen = false;
          this.post({
            type: 'settings',
            values: await this.readSettingsValues(),
          });
          return;

        case 'settings.save':
          await this.saveSettings(raw.values);
          return;

        case 'skills.open':
          this.post({
            type: 'skills.catalog',
            items: this.readSkillCatalog(),
          });
          return;

        case 'skills.toggle':
          if (typeof raw.id === 'string') {
            await this.toggleSkill(raw.id, raw.enabled === true);
          }
          return;

        case 'skills.create':
          await vscode.commands.executeCommand('agentbox.createSkill');
          this.post({ type: 'skills.catalog', items: this.readSkillCatalog() });
          return;

        case 'skills.openFolder':
          await vscode.commands.executeCommand('agentbox.openSkillsFolder');
          return;

        case 'skills.upload':
          await vscode.commands.executeCommand('agentbox.uploadSkill');
          this.post({ type: 'skills.catalog', items: this.readSkillCatalog() });
          return;

        case 'skills.sync':
          await vscode.commands.executeCommand('agentbox.syncSkills');
          this.post({ type: 'skills.catalog', items: this.readSkillCatalog() });
          await this.postSkillGroups();
          return;

        case 'skills.requestGroups':
          await this.postSkillGroups();
          return;

        case 'skills.joinGroups': {
          const ids = Array.isArray(raw.ids)
            ? raw.ids.filter(
                (item): item is string => typeof item === 'string' && item !== ''
              )
            : [];
          if (ids.length === 0) return;
          try {
            const groups = await requestSkillGroups(this.context, ids);
            this.post({ type: 'skills.groups', groups });
            this.post({
              type: 'log',
              text: `已提交 ${ids.length} 个分组申请，等待 server admin 审批。`,
            });
          } catch (error) {
            this.post({
              type: 'log',
              text: `分组申请失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
          return;
        }

        case 'session.new':
          await this.newSession();
          return;

        case 'session.select':
          if (typeof raw.id === 'string') {
            await this.selectSession(raw.id);
          }
          return;

        case 'session.close':
          if (typeof raw.id === 'string' && raw.confirm === true) {
            await this.closeSession(raw.id);
          }
          return;

        default:
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[error] ${message}`);
      this.post({ type: 'error', message });
      this.post({ type: 'busy', busy: false });
    }
  }

  private async newSession(): Promise<void> {
    if (this.busy) {
      this.post({ type: 'error', message: '请先停止正在运行的会话。' });
      return;
    }
    const session = this.createSession();
    this.sessions.push(session);
    this.activeSessionId = session.id;
    this.postSessions();
    this.postSessionLoad(session);
    this.postSkills(session);
    this.postState();
    this.postContext();
  }

  private async selectSession(id: string): Promise<void> {
    if (id === this.activeSessionId) return;
    const target = this.sessions.find((session) => session.id === id);
    if (target === undefined) return;
    if (this.busy) {
      this.post({ type: 'error', message: '请先停止正在运行的会话再切换。' });
      return;
    }
    this.activeSessionId = id;
    this.postSessions();
    this.postSessionLoad(target);
    this.postSkills(target);
    this.postState();
    this.postContext();
  }

  private async closeSession(id: string): Promise<void> {
    if (this.busy) {
      this.post({ type: 'error', message: '请先停止正在运行的会话。' });
      return;
    }
    const index = this.sessions.findIndex((session) => session.id === id);
    if (index < 0) return;
    const removed = this.sessions[index]!;
    this.sessions.splice(index, 1);
    await this.disposeSession(removed);

    if (this.sessions.length === 0) {
      this.sessions.push(this.createSession());
    }
    if (this.activeSessionId === id) {
      const next = this.sessions[Math.min(index, this.sessions.length - 1)]!;
      this.activeSessionId = next.id;
    }
    this.postSessions();
    this.postSessionLoad(this.activeSession);
    this.postSkills(this.activeSession);
    this.postState();
    this.postContext();
  }

  private buildActiveContext(
    root: string,
    includeFile: boolean,
    includeSelection: boolean
  ): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || editor.document.uri.scheme !== 'file') {
      return undefined;
    }

    const document = editor.document;
    const rel = toWorkspacePath(root, document.uri.fsPath);
    const inside = rel !== undefined;

    const selection = editor.selection;
    const selectionText =
      includeSelection && inside && !selection.isEmpty
        ? document.getText(selection)
        : undefined;

    return buildContextText({
      ...(includeFile && rel !== undefined
        ? {
            filePath: rel,
            languageId: document.languageId,
            fileContent: document.getText(),
          }
        : {}),
      ...(selectionText !== undefined
        ? {
            selection: {
              text: selectionText,
              startLine: selection.start.line + 1,
              endLine: selection.end.line + 1,
            },
          }
        : {}),
    });
  }

  private postContext(): void {
    if (this.surfaces.length === 0) return;
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || editor.document.uri.scheme !== 'file') {
      this.post({ type: 'context', context: {} });
      return;
    }

    const root = this.currentRoot();
    const rel =
      root === undefined
        ? undefined
        : toWorkspacePath(root, editor.document.uri.fsPath);
    if (rel === undefined) {
      this.post({ type: 'context', context: {} });
      return;
    }

    const selection = editor.selection;
    this.post({
      type: 'context',
      context: {
        file: rel,
        ...(!selection.isEmpty
          ? {
              selection: {
                startLine: selection.start.line + 1,
                endLine: selection.end.line + 1,
                preview: editor.document
                  .getText(selection)
                  .replace(/\s+/g, ' ')
                  .slice(0, 200),
              },
            }
          : {}),
      },
    });
  }

  /**
   * Forward a controller message to the webview. File changes are de-duplicated
   * within a turn: Codex `fileChange` already renders chips in its tool card,
   * while a VS Code watcher covers shell writes that Codex does not report.
   */
  private emit(session: ChatSession, message: SessionEvent): void {
    this.logEvent(message);

    if (message.type === 'reasoning.delta') {
      if (session.reasoningKind === undefined && message.kind !== undefined) {
        session.reasoningKind = message.kind;
      }
      session.reasoningBuffer += message.text;
      if (session.id === this.activeSessionId) {
        session.reasoningPending += message.text;
        this.scheduleReasoningFlush(session);
      }
      return;
    }
    if (message.type === 'reasoning.end') {
      this.flushReasoning(
        session,
        message.text !== '' ? message.text : session.reasoningBuffer,
        message.kind ?? session.reasoningKind
      );
      return;
    }

    let outgoing: SessionEvent = message;

    if (message.type === 'turn.start') {
      session.changedThisTurn.clear();
      session.reasoningBuffer = '';
      session.reasoningPending = '';
      session.reasoningKind = undefined;
      if (session.reasoningTimer !== undefined) {
        clearTimeout(session.reasoningTimer);
        session.reasoningTimer = undefined;
      }
    } else if (
      message.type === 'tool.start' &&
      message.name === 'fileChange' &&
      isRecord(message.args) &&
      Array.isArray(message.args.changes)
    ) {
      const changes = message.args.changes.map((change) => {
        if (!isRecord(change) || typeof change.path !== 'string') {
          return change;
        }
        const path = this.normalizePath(session, change.path);
        session.changedThisTurn.add(path);
        return { ...change, path };
      });
      // File chips must stay workspace-relative so the host can open them.
      outgoing = { ...message, args: { ...message.args, changes } };
    } else if (message.type === 'file.changed') {
      const path = this.normalizePath(session, message.path);
      if (session.changedThisTurn.has(path)) return;
      session.changedThisTurn.add(path);
      outgoing = { ...message, path };
    } else if (message.type === 'turn.end') {
      if (session.reasoningBuffer !== '' || session.reasoningPending !== '') {
        this.flushReasoning(
          session,
          session.reasoningBuffer,
          session.reasoningKind
        );
      }
    }

    if (outgoing.type === 'tool.start') {
      session.toolDetails.set(outgoing.callId, {
        name: outgoing.name,
        args: outgoing.args,
        result: '',
        ok: null,
      });
    } else if (outgoing.type === 'tool.end') {
      const existing = session.toolDetails.get(outgoing.callId);
      session.toolDetails.set(outgoing.callId, {
        name: outgoing.name,
        args: existing?.args ?? {},
        result: outgoing.result,
        ok: outgoing.ok,
      });
    }

    session.events.push(outgoing);
    if (session.id === this.activeSessionId) {
      this.post(outgoing);
    }
  }

  private scheduleReasoningFlush(session: ChatSession): void {
    if (session.reasoningTimer !== undefined) return;
    session.reasoningTimer = setTimeout(() => {
      session.reasoningTimer = undefined;
      const text = session.reasoningPending;
      session.reasoningPending = '';
      if (text !== '' && session.id === this.activeSessionId) {
        this.post({ type: 'reasoning.delta', text });
      }
    }, 100);
  }

  private flushReasoning(
    session: ChatSession,
    finalText: string,
    kind?: 'summary' | 'raw'
  ): void {
    if (session.reasoningTimer !== undefined) {
      clearTimeout(session.reasoningTimer);
      session.reasoningTimer = undefined;
    }
    const pending = session.reasoningPending;
    session.reasoningPending = '';
    if (pending !== '' && session.id === this.activeSessionId) {
      this.post({
        type: 'reasoning.delta',
        text: pending,
        ...(kind ? { kind } : {}),
      });
    }
    const text = finalText.trim() === '' ? session.reasoningBuffer : finalText;
    session.reasoningBuffer = '';
    session.reasoningKind = undefined;
    if (text.trim() === '') return;
    const stored =
      text.length <= MAX_REASONING_STORE_CHARS
        ? text
        : `${text.slice(0, MAX_REASONING_STORE_CHARS)}\n…（思考内容已截断）`;
    const event: SessionEvent = {
      type: 'reasoning.end',
      text: stored,
      ...(kind ? { kind } : {}),
    };
    session.events.push(event);
    if (session.id === this.activeSessionId) {
      this.post(event);
    }
  }

  /** Full tool details live in the "AgentBox Chat" output channel. */
  private logEvent(message: SessionEvent): void {
    switch (message.type) {
      case 'turn.start':
        this.output.appendLine(`[turn.start] ${message.turnId}`);
        break;
      case 'turn.end':
        this.output.appendLine(`[turn.end] ${message.reason}`);
        this.output.appendLine('');
        break;
      case 'error':
        this.output.appendLine(
          `[error] ${message.code ?? 'ERROR'}: ${message.message}`
        );
        break;
      case 'tool.start':
        this.output.appendLine(
          `[tool.start] ${message.name} (${message.callId})`
        );
        this.output.appendLine(stringifyForLog(message.args));
        break;
      case 'tool.end':
        this.output.appendLine(
          `[tool.end] ${message.name} ok=${message.ok} (${message.callId})`
        );
        this.output.appendLine(message.result);
        this.output.appendLine('');
        break;
      default:
        break;
    }
  }

  private normalizePath(session: ChatSession, path: string): string {
    if (session.root === undefined) return path;
    const absolute = isAbsolute(path) ? path : resolve(session.root, path);
    return toWorkspacePath(session.root, absolute) ?? path;
  }

  private ensureWatcher(root: string): void {
    if (this.watcher !== undefined && this.watcherRoot === root) return;
    this.disposeWatcher();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onChange = (uri: vscode.Uri): void => {
      this.onWorkspaceFileChanged(root, uri);
    };
    this.watcherListeners = [
      watcher.onDidCreate(onChange),
      watcher.onDidChange(onChange),
    ];
    this.watcher = watcher;
    this.watcherRoot = root;
  }

  private disposeWatcher(): void {
    for (const listener of this.watcherListeners) {
      listener.dispose();
    }
    this.watcherListeners = [];
    this.watcher?.dispose();
    this.watcher = undefined;
    this.watcherRoot = undefined;
  }

  private onWorkspaceFileChanged(root: string, uri: vscode.Uri): void {
    const session = this.activeSession;
    if (session.controller?.busy !== true) return;
    const path = toWorkspacePath(root, uri.fsPath);
    if (path === undefined || isIgnoredWatchPath(path)) return;
    this.emit(session, { type: 'file.changed', path });
  }

  private postState(): void {
    const root = this.currentRoot();
    this.post({
      type: 'state',
      busy: this.activeSession.controller?.busy ?? false,
      runtime: this.runtimeId,
      model: this.modelLabel,
      provider: this.providerLabel,
      workspaceRoot: root,
    });
  }

  private post(message: HostToWebview): void {
    if (this.disposed) return;
    for (const surface of [...this.surfaces]) {
      surface.post(message);
    }
  }

  private async openToolDetails(
    session: ChatSession,
    callId: string
  ): Promise<void> {
    const detail = session.toolDetails.get(callId);
    if (detail === undefined) {
      this.showOutput();
      return;
    }
    const commandTools = new Set([
      'commandExecution',
      'run_shell',
      'shell',
      'shellCommand',
    ]);
    const content = [
      `# ${detail.name}`,
      '',
      `Status: ${detail.ok === null ? 'running' : detail.ok ? 'completed' : 'failed'}`,
      '',
      '## Arguments',
      stringifyForLog(detail.args),
      '',
      '## Output',
      detail.result === '' ? '(no output)' : detail.result,
      '',
    ].join('\n');
    const document = await vscode.workspace.openTextDocument({
      content,
      language: commandTools.has(detail.name) ? 'shellscript' : 'plaintext',
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async openWorkspaceFile(path: string): Promise<void> {
    const root = this.currentRoot();
    if (root === undefined) {
      void vscode.window.showWarningMessage('AgentBox: open a workspace first.');
      return;
    }
    if (path === '' || isAbsolute(path)) return;

    const absolute = resolve(root, path);
    if (toWorkspacePath(root, absolute) === undefined) return;

    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(absolute)
      );
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `AgentBox: cannot open ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(media, 'chat.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>AgentBox</title>
</head>
<body>
  <div class="app">
    <header class="header">
      <div class="brand">
        <span class="brand-mark">⌘</span>
        <span>AgentBox</span>
      </div>
      <div class="meta"></div>
      <button id="open-editor" class="icon-button" title="在编辑器中打开（可拖动布局）" aria-label="在编辑器中打开">⧉</button>
      <button id="skills" class="icon-button" title="技能" aria-label="技能">✦</button>
      <button id="settings" class="icon-button" title="设置" aria-label="设置">⚙</button>
    </header>
    <div class="session-row">
      <div id="session-bar" class="session-bar" role="tablist" aria-label="会话列表"></div>
      <button id="new" class="session-new" title="新建会话" aria-label="新建会话">＋</button>
    </div>
    <div id="chat-area" class="chat-area">
      <main id="transcript" class="transcript" aria-live="polite" aria-label="对话记录"></main>
      <nav id="question-nav" class="question-nav" aria-label="用户问题导航" hidden></nav>
      <div id="question-tooltip" class="question-tooltip" hidden></div>
    </div>

    <section id="timeline" class="timeline" aria-label="任务活动时间线">
      <div class="timeline-head">
        <span class="timeline-title">活动</span>
        <span id="timeline-summary" class="timeline-summary"></span>
        <span id="timeline-tokens" class="timeline-tokens" hidden></span>
        <span id="timeline-elapsed" class="timeline-elapsed">等待任务…</span>
        <button id="timeline-toggle" class="timeline-toggle" type="button" title="收起活动时间线" aria-label="收起活动时间线" aria-expanded="true">▾</button>
      </div>
      <div class="timeline-lane">
        <span class="timeline-label">思考</span>
        <div id="lane-thinking" class="timeline-track"></div>
      </div>
      <div class="timeline-lane">
        <span class="timeline-label">生成</span>
        <div id="lane-generation" class="timeline-track"></div>
      </div>
      <div class="timeline-lane">
        <span class="timeline-label">工具</span>
        <div id="lane-tool" class="timeline-track"></div>
      </div>
      <div id="timeline-tooltip" class="timeline-tooltip" hidden></div>
    </section>

    <section class="composer">
      <div id="skill-bar" class="skill-bar" hidden aria-label="已注入的 Skill"></div>
      <div id="context-bar" class="context-bar" hidden>
        <button id="toggle-file" class="context-toggle" type="button" aria-pressed="false" title="加入当前文件">
          <svg class="context-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 3h6l4 4v14H7V3Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
            <path d="M13 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          </svg>
          <span id="file-label">当前文件</span>
        </button>
        <button id="toggle-selection" class="context-toggle" type="button" aria-pressed="false" title="加入选区">
          <svg class="context-icon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4.5" y="4.5" width="15" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.5"/>
          </svg>
          <span id="selection-label">选区</span>
        </button>
      </div>
      <div class="composer-input-wrap">
        <textarea id="input" rows="1" aria-label="消息输入框" placeholder="向 AgentBox 提问…（Enter 发送，Shift+Enter 换行；@ 引用 Skill）"></textarea>
        <div id="mention-menu" class="mention-menu" role="listbox" aria-label="引用 Skill" hidden></div>
      </div>
      <div class="composer-actions">
        <span id="status" class="status"></span>
        <button id="submit" class="submit-button" title="发送" aria-label="发送">
          <svg id="icon-send" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.5 11.6 20.5 4l-6.8 16-2.1-6.4-8.1-2Z" fill="currentColor"/>
          </svg>
          <svg id="icon-stop" viewBox="0 0 24 24" aria-hidden="true" hidden>
            <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </section>

    <div id="settings-scrim" class="settings-scrim" hidden></div>
    <aside id="settings-panel" class="settings-panel" role="dialog" aria-modal="true" aria-label="AgentBox 设置" hidden>
      <div class="settings-header">
        <span>设置</span>
        <button id="settings-close" class="icon-button" title="关闭设置" aria-label="关闭设置">✕</button>
      </div>
      <div class="settings-main">
      <div class="settings-tabs" role="tablist" aria-label="设置分类">
        <button class="settings-tab active" type="button" data-settings-tab="model">
          <svg class="settings-tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="8" rx="1.5"/><path d="M5 13h6M8 11v2"/></svg>
          模型
        </button>
        <button class="settings-tab" type="button" data-settings-tab="skills">
          <svg class="settings-tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3.5h6.5L13 6v6.5H4z"/><path d="M10 3.5V6h3M6 8.5h5M6 10.5h3"/></svg>
          Skill
        </button>
        <button class="settings-tab" type="button" data-settings-tab="advanced">
          <svg class="settings-tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h10"/><circle cx="6" cy="4.5" r="1.4"/><circle cx="10" cy="8" r="1.4"/><circle cx="7" cy="11.5" r="1.4"/></svg>
          高级
        </button>
      </div>
      <div class="settings-body">
        <div class="settings-page" data-settings-page="model">
          <label class="field">
            <span>Runtime</span>
            <select id="setting-runtime">
              <option value="codex">codex</option>
              <option value="fake">fake（UI 冒烟）</option>
            </select>
          </label>
          <label class="field">
            <span>任务模式</span>
            <select id="setting-task-profile">
              <option value="simple">simple（静态文件，8 步 / 90s）</option>
              <option value="code">code（常规编码，20 步 / 180s）</option>
              <option value="research">research（研究/多步，30 步 / 300s）</option>
            </select>
          </label>
          <label class="field">
            <span>Provider</span>
            <input id="setting-provider" type="text" autocomplete="off" />
          </label>
          <label class="field">
            <span>模型</span>
            <input id="setting-model" type="text" autocomplete="off" />
          </label>
          <label class="field">
            <span>Base URL</span>
            <input id="setting-base-url" type="text" autocomplete="off" />
          </label>
          <label class="field">
            <span>API Key</span>
            <div class="field-inline">
              <input id="setting-api-key" type="password" autocomplete="off" placeholder="留空表示不修改" />
              <button id="clear-api-key" class="text-button" type="button">清除</button>
            </div>
          </label>
          <label class="field">
            <span>推理强度</span>
            <select id="setting-reasoning-effort">
              <option value="low">low（更快，思考更少）</option>
              <option value="medium">medium（默认）</option>
              <option value="high">high（更深入，更慢）</option>
            </select>
          </label>
          <label class="field">
            <span>审批策略</span>
            <select id="setting-approval">
              <option value="on-request">on-request（按需）</option>
              <option value="untrusted">untrusted（每条命令询问）</option>
              <option value="never">never（不询问）</option>
            </select>
          </label>
          <p class="settings-hint">
            审批策略：<b>untrusted</b> 每条命令都询问；<b>on-request</b> 仅在 Codex 请求时询问；
            <b>never</b> 不询问。
          </p>
        </div>

        <div class="settings-page" data-settings-page="skills" hidden>
          <label class="field">
            <span>Server URL</span>
            <input id="setting-skill-server-url" type="text" autocomplete="off" placeholder="http://127.0.0.1:4770" />
          </label>
          <label class="field">
            <span>Server Token</span>
            <div class="field-inline">
              <input id="setting-skill-server-token" type="password" autocomplete="off" placeholder="留空表示不修改" title="上传需要 author/admin token；本地 dev 用 dev-author 或 dev-admin" />
              <button id="clear-skill-server-token" class="text-button" type="button">清除</button>
            </div>
          </label>
          <label class="field checkbox-field">
            <input id="setting-skills-auto-sync" type="checkbox" />
            <span>启动时自动同步</span>
          </label>
          <label class="field">
            <span>Required 缺失</span>
            <select id="setting-skills-required-missing">
              <option value="warn">warn（警告并继续）</option>
              <option value="block">block（阻断本轮）</option>
            </select>
          </label>
          <label class="field">
            <span>本地 Skill 目录</span>
            <input id="setting-skills-local-dir" type="text" autocomplete="off" placeholder="留空使用 ~/.agentbox/skills/local" />
          </label>
          <div class="settings-section">Skill Groups</div>
          <div class="skill-group-picker-row">
            <details id="skill-group-picker" class="multi-select">
              <summary id="skill-group-summary">选择分组</summary>
              <div id="settings-skill-groups" class="multi-select-menu"></div>
            </details>
            <button id="join-skill-groups" class="primary" type="button">申请加入</button>
          </div>
        </div>

        <div class="settings-page" data-settings-page="advanced" hidden>
          <label class="field">
            <span>Codex 命令</span>
            <input id="setting-codex-command" type="text" autocomplete="off" />
          </label>
          <label class="field">
            <span>额外指令</span>
            <textarea id="setting-extra-instructions" rows="4" placeholder="追加到 developer instructions"></textarea>
          </label>
        </div>

      </div>
      </div>
      <div class="settings-footer">
        <p id="settings-error" class="settings-error" hidden></p>
        <div class="settings-actions">
          <button id="settings-cancel" class="secondary" type="button">取消</button>
          <button id="settings-save" class="primary" type="button">保存</button>
        </div>
      </div>
    </aside>

    <div id="skills-scrim" class="skills-scrim" hidden></div>
    <aside id="skills-panel" class="skills-panel" role="dialog" aria-modal="true" aria-label="Skill 选择" hidden>
      <div class="skills-header">
        <span>技能</span>
        <button id="skills-close" class="icon-button" title="关闭技能面板" aria-label="关闭技能面板">✕</button>
      </div>
      <div class="skills-main">
        <nav id="skills-nav" class="skills-nav" aria-label="Skill 分类"></nav>
        <div id="skills-list" class="skills-list"></div>
      </div>
      <div class="skills-actions">
        <button id="skills-create" class="secondary" type="button">新建</button>
        <button id="skills-folder" class="secondary" type="button">打开目录</button>
        <button id="skills-upload" class="secondary" type="button">上传</button>
        <button id="skills-sync" class="secondary" type="button">同步远程</button>
      </div>
    </aside>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
