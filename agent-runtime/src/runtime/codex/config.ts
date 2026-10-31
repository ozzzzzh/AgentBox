import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeError } from '../../errors.js';
import type { RuntimeConfig } from '../../types.js';

export interface PreparedCodexHome {
  home: string;
  /** Remove the temporary home; never touches a caller-provided home. */
  cleanup(): void;
}

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

/**
 * Build an isolated CODEX_HOME/config.toml from RuntimeConfig.
 *
 * Codex 0.165 only accepts wire_api="responses"; the legacy "chat" value makes
 * config loading fail. The provider table is only written when baseUrl is set.
 */
export function prepareCodexHome(config: RuntimeConfig): PreparedCodexHome {
  const codex = config.codex ?? {};
  const providedHome = codex.home;
  const home =
    providedHome !== undefined
      ? resolve(providedHome)
      : mkdtempSync(join(tmpdir(), 'agentbox-codex-'));
  const temporary = providedHome === undefined;

  if (codex.provider !== undefined && codex.baseUrl === undefined) {
    throw new RuntimeError(
      'INVALID_CONFIG',
      'codex.baseUrl is required when codex.provider is set'
    );
  }

  mkdirSync(home, { recursive: true });

  const topLevel: string[] = [];
  if (codex.model !== undefined) {
    topLevel.push(`model = ${tomlString(codex.model)}`);
  }
  if (codex.baseUrl !== undefined) {
    const providerId = codex.provider ?? 'agentbox';
    topLevel.push(`model_provider = ${tomlString(providerId)}`);
  }
  if (codex.modelCatalogJson !== undefined) {
    topLevel.push(
      `model_catalog_json = ${tomlString(codex.modelCatalogJson)}`
    );
  }

  const tables: string[] = [
    '[analytics]',
    'enabled = false',
  ];

  if (codex.baseUrl !== undefined) {
    const providerId = codex.provider ?? 'agentbox';
    tables.push(
      '',
      `[model_providers.${tomlString(providerId)}]`,
      `name = ${tomlString('AgentBox')}`,
      `base_url = ${tomlString(codex.baseUrl)}`,
      'wire_api = "responses"',
      `env_key = ${tomlString(codex.apiKeyEnv ?? 'MODEL_API_KEY')}`
    );
  }

  const contents = `${[...topLevel, '', ...tables].join('\n')}\n`;
  writeFileSync(join(home, 'config.toml'), contents, 'utf8');

  return {
    home,
    cleanup(): void {
      if (temporary) {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}
