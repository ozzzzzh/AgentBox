import * as vscode from 'vscode';
import type { ApprovalDecision } from '@agentbox/runtime';
import {
  formatArgs,
  type ApprovalPrompt,
  type TurnUi,
} from '../controller';

/**
 * VS Code implementation of TurnUi:
 *  - OutputChannel for streamed text and event lines
 *  - modal warning for approval
 *  - status bar + context key for busy state
 */
export class VsCodeTurnUi implements TurnUi, vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private readonly status: vscode.StatusBarItem;
  private atLineStart = true;

  constructor() {
    this.channel = vscode.window.createOutputChannel('AgentBox');
    this.status = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.status.text = '$(robot) AgentBox';
    this.status.tooltip = 'AgentBox runtime (V1 FakeRuntime)';
  }

  appendText(text: string): void {
    if (text.length === 0) return;
    this.channel.append(text);
    this.atLineStart = text.endsWith('\n');
  }

  appendEventLine(line: string): void {
    if (!this.atLineStart) {
      this.channel.append('\n');
    }
    this.channel.appendLine(line);
    this.atLineStart = true;
  }

  async requestApproval(prompt: ApprovalPrompt): Promise<ApprovalDecision> {
    const detail =
      `Tool: ${prompt.name}\nArguments: ${formatArgs(prompt.args)}` +
      (prompt.warning !== undefined ? `\nWarning: ${prompt.warning}` : '');
    const choice = await vscode.window.showWarningMessage(
      'AgentBox requires approval',
      { modal: true, detail },
      'Allow',
      'Deny'
    );

    return choice === 'Allow' ? 'allow' : 'deny';
  }

  setBusy(busy: boolean): void {
    if (busy) {
      this.status.text = '$(sync~spin) AgentBox: running';
      this.status.show();
    } else {
      this.status.text = '$(robot) AgentBox';
      this.status.hide();
    }
    void vscode.commands.executeCommand(
      'setContext',
      'agentbox.busy',
      busy
    );
  }

  showError(message: string): void {
    void vscode.window.showErrorMessage(`AgentBox: ${message}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
    this.status.dispose();
  }
}
