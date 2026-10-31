import * as vscode from 'vscode';
import { ChatViewProvider } from './chat-view';
import { RuntimeController } from './controller';
import { evaluateApprovalPolicy } from './file-policy';
import { ToolLoopDetector } from './loop-detector';
import {
  createAgentRuntime,
  readDenyWritePatterns,
  readLoopDetectionOptions,
  readModelSettings,
  secretKey,
} from './runtime-host';
import { VsCodeTurnUi } from './ui/vscode-ui';

let controller: RuntimeController | undefined;
let ui: VsCodeTurnUi | undefined;
let controllerRoot: string | undefined;
let controllerSignature: string | undefined;
let chatProvider: ChatViewProvider | undefined;

async function disposeController(): Promise<void> {
  const current = controller;
  controller = undefined;
  controllerRoot = undefined;
  controllerSignature = undefined;
  await current?.dispose();
  ui?.dispose();
  ui = undefined;
}

async function getController(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<RuntimeController> {
  const bundle = await createAgentRuntime(context, workspaceRoot);

  if (
    controller !== undefined &&
    controllerRoot === workspaceRoot &&
    controllerSignature === bundle.signature
  ) {
    return controller;
  }

  await disposeController();

  const nextUi = new VsCodeTurnUi();
  const loopOptions = readLoopDetectionOptions();
  const nextController = new RuntimeController({
    runtime: bundle.runtime,
    workspaceRoot,
    limits: bundle.limits,
    ui: nextUi,
    approvalPolicy: (prompt) =>
      evaluateApprovalPolicy(prompt, workspaceRoot, readDenyWritePatterns()),
    ...(loopOptions !== undefined
      ? { loopDetector: new ToolLoopDetector(loopOptions) }
      : {}),
  });

  try {
    await nextController.start();
  } catch (error) {
    nextUi.dispose();
    throw error;
  }

  controller = nextController;
  controllerRoot = workspaceRoot;
  controllerSignature = bundle.signature;
  ui = nextUi;
  return nextController;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(
    context,
    context.extensionUri,
    () => controller?.busy === true
  );
  chatProvider = provider;
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider('agentbox.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('agentbox.openChat', async () => {
      await vscode.commands.executeCommand('agentbox.chat.focus');
    }),

    vscode.commands.registerCommand('agentbox.configure', async () => {
      await provider.openSettings();
    }),

    vscode.commands.registerCommand('agentbox.runTurn', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (root === undefined) {
        void vscode.window.showWarningMessage(
          'AgentBox: open a workspace folder before running a turn.'
        );
        return;
      }

      if (chatProvider?.busy === true) {
        void vscode.window.showWarningMessage(
          'AgentBox: 侧边栏有正在运行的 turn，请先在侧边栏停止或等待完成。'
        );
        return;
      }

      const prompt = await vscode.window.showInputBox({
        title: 'AgentBox',
        prompt: 'Enter a prompt for the agent',
        value: 'Create a file named agentbox-v2.txt containing hello from AgentBox.',
        ignoreFocusOut: true,
      });
      if (prompt === undefined || prompt.trim() === '') return;

      try {
        const active = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'AgentBox: starting runtime...',
          },
          () => getController(context, root)
        );
        ui?.show();
        await active.runTurn(prompt);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `AgentBox: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),

    vscode.commands.registerCommand('agentbox.cancelTurn', async () => {
      if (chatProvider?.busy === true) {
        await chatProvider.cancel();
        return;
      }
      if (controller === undefined) {
        void vscode.window.showInformationMessage('AgentBox: no turn is running.');
        return;
      }
      await controller.cancel();
    }),

    vscode.commands.registerCommand('agentbox.showOutput', () => {
      if (chatProvider !== undefined) {
        chatProvider.showOutput();
        return;
      }
      if (ui === undefined) {
        void vscode.window.showInformationMessage(
          'AgentBox: run a turn first to create the output channel.'
        );
        return;
      }
      ui.show();
    }),

    vscode.commands.registerCommand('agentbox.setApiKey', async () => {
      const settings = readModelSettings();
      if (controller?.busy === true || chatProvider?.busy === true) {
        void vscode.window.showWarningMessage(
          'AgentBox: cancel the running turn before changing the API key.'
        );
        return;
      }
      const key = await vscode.window.showInputBox({
        title: `AgentBox: ${settings.provider} API key`,
        prompt: 'Stored in VS Code SecretStorage; never written to settings.',
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined || key.trim() === '') return;

      await context.secrets.store(secretKey(settings.provider), key.trim());
      await disposeController();
      await chatProvider?.reset();
      void vscode.window.showInformationMessage(
        `AgentBox: API key stored for ${settings.provider}.`
      );
    }),

    vscode.commands.registerCommand('agentbox.clearApiKey', async () => {
      const settings = readModelSettings();
      if (controller?.busy === true || chatProvider?.busy === true) {
        void vscode.window.showWarningMessage(
          'AgentBox: cancel the running turn before clearing the API key.'
        );
        return;
      }
      await context.secrets.delete(secretKey(settings.provider));
      await disposeController();
      await chatProvider?.reset();
      void vscode.window.showInformationMessage(
        `AgentBox: API key cleared for ${settings.provider}.`
      );
    }),

    vscode.commands.registerCommand('agentbox.restartRuntime', async () => {
      if (controller?.busy === true || chatProvider?.busy === true) {
        void vscode.window.showWarningMessage(
          'AgentBox: stop the running turn before restarting the runtime.'
        );
        return;
      }
      await disposeController();
      await chatProvider?.reset();
      void vscode.window.showInformationMessage('AgentBox: runtime restarted.');
    })
  );
}

export async function deactivate(): Promise<void> {
  await disposeController();
  chatProvider?.dispose();
  chatProvider = undefined;
}
