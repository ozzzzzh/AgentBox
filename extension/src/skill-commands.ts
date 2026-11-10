import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  getSkillClientIdentity,
  readSkillSettings,
  skillServerTokenKey,
} from './runtime-host';
import {
  SkillServerClient,
  SkillServerError,
  syncRemoteSkills,
} from './skills/client';
import type { SkillPackage } from './skills/model';
import {
  deleteLocalSkill,
  readLocalSkills,
  readRemoteSkills,
  resolveLocalSkillsDir,
  scaffoldLocalSkill,
} from './skills/store';

type SkillSource = 'local' | 'remote';

interface SkillPick extends vscode.QuickPickItem {
  skill: SkillPackage;
  source: SkillSource;
  dir?: string;
  required: boolean;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function target(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders !== undefined &&
    vscode.workspace.workspaceFolders.length > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function localRoot(): string {
  const settings = readSkillSettings();
  return resolveLocalSkillsDir(settings.localDir);
}

async function serverUrl(): Promise<string | undefined> {
  const configured = readSkillSettings().serverUrl;
  if (configured !== '') return configured;
  const value = await vscode.window.showInputBox({
    title: 'AgentBox: Skill Registry URL',
    prompt: '例如 https://skills.example.internal',
    value: 'http://127.0.0.1:4770',
    ignoreFocusOut: true,
  });
  if (value === undefined || value.trim() === '') return undefined;
  await vscode.workspace
    .getConfiguration('agentbox')
    .update('skills.serverUrl', value.trim(), target());
  return value.trim();
}

async function serverToken(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const stored = await context.secrets.get(skillServerTokenKey());
  if (stored !== undefined && stored.trim() !== '') return stored.trim();
  const value = await vscode.window.showInputBox({
    title: 'AgentBox: Skill Server Token',
    prompt: 'Stored in SecretStorage; never written to settings.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined || value.trim() === '') return undefined;
  await context.secrets.store(skillServerTokenKey(), value.trim());
  return value.trim();
}

async function openSkill(skill: SkillPackage, dir?: string): Promise<void> {
  if (dir !== undefined && existsSync(join(dir, 'SKILL.md'))) {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(join(dir, 'SKILL.md'))
    );
    await vscode.window.showTextDocument(document, { preview: true });
    return;
  }
  const content = skill.files['SKILL.md'] ?? '';
  const document = await vscode.workspace.openTextDocument({
    content,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function pickLocal(): Promise<
  { skill: SkillPackage; dir: string } | undefined
> {
  const root = localRoot();
  const result = readLocalSkills(root);
  if (result.items.length === 0) {
    void vscode.window.showInformationMessage(
      `AgentBox: 本地没有 skill。目录：${root}`
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    result.items.map((item) => ({
      label: `${item.skill.manifest.id}@${item.skill.manifest.version}`,
      description: item.skill.manifest.name,
      detail: item.dir,
      item,
    })),
    { placeHolder: '选择本地 Skill', ignoreFocusOut: true }
  );
  return picked === undefined
    ? undefined
    : { skill: picked.item.skill, dir: picked.item.dir };
}

async function listItems(
  context: vscode.ExtensionContext
): Promise<SkillPick[]> {
  const settings = readSkillSettings();
  const enabled = new Set(settings.enabled);
  const disabled = new Set(settings.disabled);
  const local = readLocalSkills(resolveLocalSkillsDir(settings.localDir));
  const remote =
    settings.serverUrl === ''
      ? { items: [], errors: [] }
      : readRemoteSkills(context.globalStorageUri.fsPath, settings.serverUrl);

  const isActive = (activation: string, id: string): boolean =>
    !disabled.has(id) &&
    (activation === 'always' || enabled.has(id));

  const items: SkillPick[] = [];
  for (const item of remote.items) {
    const { manifest } = item.skill;
    items.push({
      label: `${item.required ? '$(lock)' : '$(cloud)'} ${manifest.id}@${manifest.version}`,
      description: item.required ? 'remote · required' : 'remote',
      detail: manifest.name,
      picked: item.required || isActive(manifest.activation, manifest.id),
      skill: item.skill,
      source: 'remote',
      required: item.required,
    });
  }
  for (const item of local.items) {
    const { manifest } = item.skill;
    const active = isActive(manifest.activation, manifest.id);
    items.push({
      label: `${active ? '$(check)' : '$(circle-outline)'} ${manifest.id}@${manifest.version}`,
      description: 'local',
      detail: manifest.name,
      picked: active,
      skill: item.skill,
      source: 'local',
      dir: item.dir,
      required: false,
    });
  }
  return items;
}

async function showSkillActions(
  context: vscode.ExtensionContext,
  pick: SkillPick
): Promise<void> {
  const actions: string[] = ['打开 SKILL.md'];
  if (pick.source === 'local') {
    actions.push('启用/停用', '上传到 Registry', '删除本地 skill');
  } else if (!pick.required) {
    actions.push('启用/停用');
  }
  const action = await vscode.window.showQuickPick(actions, {
    placeHolder: `${pick.skill.manifest.id}@${pick.skill.manifest.version}`,
    ignoreFocusOut: true,
  });
  if (action === undefined) return;

  if (action === '打开 SKILL.md') {
    await openSkill(pick.skill, pick.dir);
    return;
  }
  if (action === '启用/停用') {
    const config = vscode.workspace.getConfiguration('agentbox');
    const enabled = config.get<string[]>('skills.enabled', []);
    const disabled = config.get<string[]>('skills.disabled', []);
    const id = pick.skill.manifest.id;
    const active =
      !disabled.includes(id) &&
      (pick.skill.manifest.activation === 'always' || enabled.includes(id));
    const nextEnabled = active
      ? enabled.filter((item) => item !== id)
      : [...new Set([...enabled, id])];
    const nextDisabled = active
      ? [...new Set([...disabled, id])]
      : disabled.filter((item) => item !== id);
    await config.update('skills.enabled', nextEnabled, target());
    await config.update('skills.disabled', nextDisabled, target());
    void vscode.window.showInformationMessage(
      `AgentBox: ${id} ${active ? '已停用' : '已启用'}。下一条 prompt 生效。`
    );
    return;
  }
  if (action === '上传到 Registry') {
    await uploadSkill(context, pick);
    return;
  }
  if (action === '删除本地 skill') {
    const answer = await vscode.window.showWarningMessage(
      `删除本地 skill ${pick.skill.manifest.id}？`,
      { modal: true },
      '删除'
    );
    if (answer !== '删除') return;
    deleteLocalSkill(localRoot(), pick.skill.manifest.id);
    void vscode.window.showInformationMessage('AgentBox: 本地 skill 已删除。');
  }
}

async function uploadSkill(
  context: vscode.ExtensionContext,
  pick: SkillPick
): Promise<void> {
  const url = await serverUrl();
  if (url === undefined) return;
  const stored = await context.secrets.get(skillServerTokenKey());
  let token = stored?.trim() || undefined;
  // Local dev servers are seeded with dev-admin; avoid a token prompt for
  // local uploads. A manual server with custom tokens can still set a token.
  if (token === undefined && isLoopbackUrl(url)) token = 'dev-admin';
  if (token === undefined) token = await serverToken(context);
  if (token === undefined) return;
  try {
    let result;
    try {
      result = await new SkillServerClient(url, token).upload(pick.skill);
    } catch (error) {
      if (!(error instanceof SkillServerError && error.status === 401)) {
        throw error;
      }
      const retryToken = await serverToken(context);
      if (retryToken === undefined) return;
      result = await new SkillServerClient(url, retryToken).upload(pick.skill);
    }
    void vscode.window.showInformationMessage(
      `AgentBox: ${result.id}@${result.version} 已上传，状态 ${result.status}。等待 reviewer 审批。`
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `AgentBox: 上传失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function registerSkillCommands(
  context: vscode.ExtensionContext
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('agentbox.skills', async () => {
      const items = await listItems(context);
      if (items.length === 0) {
        void vscode.window.showInformationMessage(
          `AgentBox: 没有可用 skill。执行 "AgentBox: Create Skill" 或同步远程 skill。`
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: '选择 Skill',
        ignoreFocusOut: true,
      });
      if (pick !== undefined) await showSkillActions(context, pick);
    }),

    vscode.commands.registerCommand('agentbox.createSkill', async () => {
      const id = await vscode.window.showInputBox({
        title: 'AgentBox: Create Skill',
        prompt: 'Skill id (lowercase, 3-64 chars)',
        value: 'my-skill',
        ignoreFocusOut: true,
      });
      if (id === undefined || id.trim() === '') return;
      const name = await vscode.window.showInputBox({
        title: 'AgentBox: Create Skill',
        prompt: 'Display name',
        value: id.trim(),
        ignoreFocusOut: true,
      });
      if (name === undefined || name.trim() === '') return;
      const owner = await vscode.window.showInputBox({
        title: 'AgentBox: Create Skill',
        prompt: 'Owner',
        value: process.env.USERNAME ?? process.env.USER ?? 'me',
        ignoreFocusOut: true,
      });
      if (owner === undefined || owner.trim() === '') return;
      try {
        const root = localRoot();
        mkdirSync(root, { recursive: true });
        const created = scaffoldLocalSkill(root, {
          id: id.trim(),
          name: name.trim(),
          owner: owner.trim(),
        });
        await openSkill(created.skill, created.dir);
        void vscode.window.showInformationMessage(
          `AgentBox: 已创建 ${created.skill.manifest.id}，编辑 SKILL.md 后启用/上传。`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          `AgentBox: 创建失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    vscode.commands.registerCommand('agentbox.openSkillsFolder', async () => {
      const root = localRoot();
      mkdirSync(root, { recursive: true });
      await vscode.env.openExternal(vscode.Uri.file(root));
    }),

    vscode.commands.registerCommand('agentbox.validateSkill', async () => {
      const picked = await pickLocal();
      if (picked === undefined) return;
      void vscode.window.showInformationMessage(
        `AgentBox: ${picked.skill.manifest.id}@${picked.skill.manifest.version} 校验通过。`
      );
    }),

    vscode.commands.registerCommand('agentbox.uploadSkill', async () => {
      const picked = await pickLocal();
      if (picked === undefined) return;
      await uploadSkill(context, {
        label: picked.skill.manifest.id,
        skill: picked.skill,
        source: 'local',
        dir: picked.dir,
        required: false,
      });
    }),

    vscode.commands.registerCommand('agentbox.syncSkills', async () => {
      const url = await serverUrl();
      if (url === undefined) return;
      const stored = await context.secrets.get(skillServerTokenKey());
      let token = stored?.trim() || undefined;
      const identity = await getSkillClientIdentity(context);
      try {
        let result;
        try {
          result = await syncRemoteSkills(
            context.globalStorageUri.fsPath,
            url,
            token,
            identity.id,
            identity.name
          );
        } catch (error) {
          // Loopback dev servers allow anonymous read. If a real server asks
          // for auth, prompt once and retry.
          if (!(error instanceof SkillServerError && error.status === 401)) {
            throw error;
          }
          token = await serverToken(context);
          if (token === undefined) return;
          result = await syncRemoteSkills(
            context.globalStorageUri.fsPath,
            url,
            token,
            identity.id,
            identity.name
          );
        }
        const required = result.index.skills.filter((item) => item.required);
        const message = `AgentBox: 已同步 ${result.index.skills.length} 个远程 skill，其中 required ${required.length} 个。`;
        if (result.warnings.length > 0) {
          void vscode.window.showWarningMessage(
            `${message}\n${result.warnings.slice(0, 5).join('\n')}`
          );
        } else {
          void vscode.window.showInformationMessage(message);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `AgentBox: 同步失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    vscode.commands.registerCommand('agentbox.setSkillServerToken', async () => {
      const value = await vscode.window.showInputBox({
        title: 'AgentBox: Skill Server Token',
        prompt: 'Stored in SecretStorage; never written to settings.',
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined || value.trim() === '') return;
      await context.secrets.store(skillServerTokenKey(), value.trim());
      void vscode.window.showInformationMessage(
        'AgentBox: Skill server token stored.'
      );
    }),

    vscode.commands.registerCommand('agentbox.skillSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'agentbox.skills'
      );
    }),
  ];
}
