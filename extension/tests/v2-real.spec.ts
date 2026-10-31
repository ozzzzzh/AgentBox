import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '@agentbox/runtime';
import {
  RuntimeController,
  type ApprovalPrompt,
  type TurnUi,
} from '../src/controller';
import { buildCodexRuntimeConfig, type ModelSettings } from '../src/settings';

class RealTurnUi implements TurnUi {
  texts: string[] = [];
  lines: string[] = [];
  errors: string[] = [];
  busy: boolean[] = [];

  appendText(text: string): void {
    this.texts.push(text);
  }

  appendEventLine(line: string): void {
    this.lines.push(line);
  }

  async requestApproval(prompt: ApprovalPrompt): Promise<'allow' | 'deny'> {
    this.lines.push(`approval ${prompt.name} -> allow`);
    return 'allow';
  }

  setBusy(busy: boolean): void {
    this.busy.push(busy);
  }

  showError(message: string): void {
    this.errors.push(message);
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 180_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for V2 turn');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('V2 real Codex integration', () => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const command = process.env.CODEX_COMMAND;
  const enabled = process.env.V2_E2E === '1' && apiKey !== undefined && command !== undefined;

  it.skipIf(!enabled)(
    'runs a real Codex turn through RuntimeController',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'agentbox-v2-ws-'));
      const home = mkdtempSync(join(tmpdir(), 'agentbox-v2-home-'));
      const target = join(workspace, 'v2-real.txt');
      const settings: ModelSettings = {
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        scope: 'external',
        command: command!,
        home,
        approvalPolicy: 'on-request',
        permissions: ':workspace',
        autoSetupSandbox: true,
        extraInstructions: '',
      };
      const config = buildCodexRuntimeConfig({
        settings,
        workspaceRoot: workspace,
        apiKey: apiKey!,
        home,
        limits: { turnTimeoutMs: 180_000 },
      });

      const runtime = createRuntime(config);
      const ui = new RealTurnUi();
      const controller = new RuntimeController({
        runtime,
        workspaceRoot: workspace,
        limits: config.limits,
        ui,
      });

      try {
        await controller.start();
        const handle = await controller.runTurn(
          'Create a file named v2-real.txt in the current working directory containing exactly: v2-ok. Then reply DONE.'
        );
        expect(handle).not.toBeNull();
        await waitFor(() =>
          ui.lines.some((line) => line.includes('turn end_turn'))
        );

        expect(ui.errors).toEqual([]);
        expect(existsSync(target)).toBe(true);
        expect(readFileSync(target, 'utf8')).toContain('v2-ok');
        expect(controller.busy).toBe(false);
      } finally {
        await controller.dispose();
        rmSync(workspace, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    200_000
  );
});
