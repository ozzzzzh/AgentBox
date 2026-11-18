import { isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';
import {
  KnowledgeServerClient,
  KnowledgeServerError,
} from './knowledge/client';
import {
  scanWorkspace,
  workspaceRelativePath,
  type ScannerIo,
  type ScannedDocument,
} from './knowledge/scanner';
import {
  collectionForWorkspace,
  knowledgeServerTokenKey,
  readKnowledgeSettings,
} from './knowledge/settings';
import type { UpsertResponse } from './knowledge/types';
import { getSkillClientIdentity } from './runtime-host';

const MAX_BATCH_DOCS = 10;
const MAX_BATCH_BYTES = 256 * 1024;

const scannerIo: ScannerIo = {
  async findFiles(include, exclude, maxResults) {
    const uris = await vscode.workspace.findFiles(include, exclude, maxResults);
    return uris.map((uri) => uri.fsPath);
  },
  async stat(path) {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path));
    return {
      size: stat.size,
      mtimeMs: stat.mtime,
      isFile: (stat.type & vscode.FileType.File) !== 0,
      isSymbolicLink: (stat.type & vscode.FileType.SymbolicLink) !== 0,
    };
  },
  async readFile(path) {
    return vscode.workspace.fs.readFile(vscode.Uri.file(path));
  },
};

function target(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders !== undefined &&
    vscode.workspace.workspaceFolders.length > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function currentRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function createClient(
  context: vscode.ExtensionContext
): Promise<KnowledgeServerClient | undefined> {
  const settings = readKnowledgeSettings();
  if (settings.serverUrl === '') return undefined;
  const stored = await context.secrets.get(knowledgeServerTokenKey());
  const identity = await getSkillClientIdentity(context);
  return new KnowledgeServerClient(
    settings.serverUrl,
    stored?.trim() || undefined,
    identity.id,
    identity.name
  );
}

async function resolveClient(
  context: vscode.ExtensionContext
): Promise<KnowledgeServerClient | undefined> {
  const existing = await createClient(context);
  if (existing !== undefined) return existing;
  const value = await vscode.window.showInputBox({
    title: 'AgentBox: Knowledge Server URL',
    prompt: '例如 http://127.0.0.1:4771 或 https://knowledge.example.internal',
    value: 'http://127.0.0.1:4771',
    ignoreFocusOut: true,
  });
  if (value === undefined || value.trim() === '') return undefined;
  await vscode.workspace
    .getConfiguration('agentbox')
    .update('knowledge.serverUrl', value.trim(), target());
  return createClient(context);
}

function errorMessage(error: unknown): string {
  if (error instanceof KnowledgeServerError) {
    return error.code === undefined
      ? error.message
      : `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function openFileAtLine(
  path: string,
  startLine: number
): Promise<void> {
  const root = currentRoot();
  if (root === undefined) {
    void vscode.window.showWarningMessage('AgentBox: 请先打开一个工作区。');
    return;
  }
  if (path === '' || isAbsolute(path)) return;
  const absolute = resolve(root, path);
  if (workspaceRelativePath(root, absolute) === undefined) return;
  try {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(absolute)
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: true,
    });
    const line = Math.min(
      Math.max(1, Math.trunc(startLine)),
      Math.max(1, document.lineCount)
    );
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter
    );
  } catch {
    void vscode.window.showWarningMessage(
      `AgentBox: 知识引用已过期或文件不存在：${path}`
    );
  }
}

async function listServerHashes(
  client: KnowledgeServerClient,
  collection: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let offset = 0;
  while (offset < 5_000) {
    const page = await client.listDocuments(collection, 1_000, offset);
    for (const document of page.documents) {
      result.set(document.path, document.contentHash);
    }
    offset += page.documents.length;
    if (page.documents.length === 0 || offset >= page.total) break;
  }
  return result;
}

function batches(
  documents: ScannedDocument[]
): ScannedDocument[][] {
  const result: ScannedDocument[][] = [];
  let current: ScannedDocument[] = [];
  let bytes = 0;
  for (const document of documents) {
    const estimate = Buffer.byteLength(document.content, 'utf8') + document.path.length + 128;
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_DOCS || bytes + estimate > MAX_BATCH_BYTES)
    ) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(document);
    bytes += estimate;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function summarize(
  responses: UpsertResponse[]
): UpsertResponse {
  const result: UpsertResponse = {
    apiVersion: 1,
    indexed: 0,
    unchanged: 0,
    removed: 0,
    skipped: 0,
    redactions: 0,
    errors: [],
    results: [],
  };
  for (const response of responses) {
    result.indexed += response.indexed;
    result.unchanged += response.unchanged;
    result.removed += response.removed;
    result.skipped += response.skipped;
    result.redactions += response.redactions;
    result.errors.push(...response.errors);
    result.results.push(...response.results);
  }
  return result;
}

async function reindexKnowledge(
  context: vscode.ExtensionContext
): Promise<void> {
  const client = await resolveClient(context);
  if (client === undefined) return;
  const root = currentRoot();
  if (root === undefined) {
    void vscode.window.showWarningMessage('AgentBox: 请先打开一个工作区。');
    return;
  }
  const settings = readKnowledgeSettings();
  const collection = collectionForWorkspace(root, settings);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AgentBox: 索引知识库',
        cancellable: true,
      },
    async (progress, token) => {
      progress.report({ message: '扫描 workspace…' });
      const scan = await scanWorkspace({
        root,
        io: scannerIo,
        maxFiles: 5_000,
        maxFileBytes: settings.maxFileBytes,
      });
      if (token.isCancellationRequested) throw new vscode.CancellationError();

      const scannedPaths = new Set(scan.documents.map((item) => item.path));
      let changed = scan.documents;
      let removedPaths: string[] = [];
      const warnings: string[] = [];
      if (scan.truncated) {
        warnings.push('workspace 超过 5,000 个文件，只索引了前 5,000 个。');
      }

      try {
        progress.report({ message: '读取服务端索引…' });
        const server = await listServerHashes(client, collection);
        changed = scan.documents.filter(
          (document) => server.get(document.path) !== document.contentHash
        );
        removedPaths = [...server.keys()].filter((path) => !scannedPaths.has(path));
      } catch (error) {
        warnings.push(`无法读取服务端索引，将上传全部文档：${errorMessage(error)}`);
      }

      const groups = batches(changed);
      if (removedPaths.length === 0 && groups.length === 0) {
        void vscode.window.showInformationMessage(
          `AgentBox: 知识库已是最新（${scan.documents.length} 个文档）。`
        );
        return;
      }

      const responses: UpsertResponse[] = [];
      for (let index = 0; index < groups.length; index += 1) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        progress.report({
          message: `上传 ${index + 1}/${groups.length} 批（${changed.length} 个变更）…`,
        });
        const response = await client.upsert({
          collection,
          source: 'workspace',
          documents: groups[index]!.map((document) => ({
            path: document.path,
            content: document.content,
            contentHash: document.contentHash,
            mtimeMs: document.mtimeMs,
          })),
          ...(index === 0 && removedPaths.length > 0 ? { removedPaths } : {}),
        });
        responses.push(response);
      }
      if (groups.length === 0 && removedPaths.length > 0) {
        responses.push(
          await client.upsert({
            collection,
            source: 'workspace',
            documents: [],
            removedPaths,
          })
        );
      }

      const summary = summarize(responses);
      const detail = `indexed=${summary.indexed} unchanged=${summary.unchanged} removed=${summary.removed}`;
      if (summary.errors.length > 0) {
        void vscode.window.showWarningMessage(
          `AgentBox: 知识库索引完成，但有 ${summary.errors.length} 个错误。${detail}；` +
            summary.errors
              .slice(0, 3)
              .map((item) => `${item.path}: ${item.code}`)
              .join('；')
        );
      } else {
        void vscode.window.showInformationMessage(
          `AgentBox: 知识库索引完成。${detail}${warnings.length > 0 ? `（${warnings[0]}）` : ''}`
        );
      }
      }
    );
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      void vscode.window.showInformationMessage('AgentBox: 知识库索引已取消。');
      return;
    }
    void vscode.window.showErrorMessage(
      `AgentBox: 知识库索引失败：${errorMessage(error)}`
    );
  }
}

async function searchKnowledge(
  context: vscode.ExtensionContext
): Promise<void> {
  const client = await resolveClient(context);
  if (client === undefined) return;
  const root = currentRoot();
  if (root === undefined) {
    void vscode.window.showWarningMessage('AgentBox: 请先打开一个工作区。');
    return;
  }
  const query = await vscode.window.showInputBox({
    title: 'AgentBox: 搜索知识库',
    prompt: '输入关键词，例如“intern_test 增量同步”',
    ignoreFocusOut: true,
  });
  if (query === undefined || query.trim() === '') return;
  const settings = readKnowledgeSettings();
  try {
    const response = await client.search({
      collection: collectionForWorkspace(root, settings),
      query: query.trim(),
      topK: settings.topK,
      maxChars: settings.maxChars,
    });
    if (response.results.length === 0) {
      void vscode.window.showInformationMessage('AgentBox: 没有找到相关知识。');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      response.results.map((result, index) => ({
        label: `[K${index + 1}] ${result.path}:${result.startLine}`,
        description: result.heading,
        detail: result.snippet,
        path: result.path,
        line: result.startLine,
      })),
      { placeHolder: `找到 ${response.results.length} 个结果`, ignoreFocusOut: true }
    );
    if (picked !== undefined) {
      await openFileAtLine(picked.path, picked.line);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `AgentBox: 知识检索失败：${errorMessage(error)}`
    );
  }
}

async function knowledgeStatus(
  context: vscode.ExtensionContext
): Promise<void> {
  const client = await resolveClient(context);
  if (client === undefined) return;
  try {
    const status = await client.status();
    const last =
      status.lastIndexedAt === null
        ? '未索引'
        : new Date(status.lastIndexedAt).toLocaleString();
    void vscode.window.showInformationMessage(
      `AgentBox Knowledge：${status.documents} 个文档，${status.chunks} 个 chunk；` +
        `最后索引：${last}；数据库：${status.dbBytes} bytes`
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `AgentBox: 无法读取知识库状态：${errorMessage(error)}`
    );
  }
}

async function setKnowledgeServerToken(
  context: vscode.ExtensionContext
): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: 'AgentBox: Knowledge Server Token',
    prompt: '只写入 SecretStorage，不会保存到 settings.json。',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return;
  if (value.trim() === '') {
    await context.secrets.delete(knowledgeServerTokenKey());
    void vscode.window.showInformationMessage('AgentBox: 已清除 Knowledge token。');
    return;
  }
  await context.secrets.store(knowledgeServerTokenKey(), value.trim());
  void vscode.window.showInformationMessage('AgentBox: 已保存 Knowledge token。');
}

export function registerKnowledgeCommands(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('agentbox.reindexKnowledge', () =>
      reindexKnowledge(context)
    ),
    vscode.commands.registerCommand('agentbox.searchKnowledge', () =>
      searchKnowledge(context)
    ),
    vscode.commands.registerCommand('agentbox.knowledgeStatus', () =>
      knowledgeStatus(context)
    ),
    vscode.commands.registerCommand('agentbox.setKnowledgeServerToken', () =>
      setKnowledgeServerToken(context)
    ),
    vscode.commands.registerCommand('agentbox.knowledgeSettings', () =>
      vscode.commands.executeCommand('agentbox.configure')
    ),
  ];
}
