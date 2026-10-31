import type { Limits, RuntimeConfig } from '@agentbox/runtime';

export interface ModelSettings {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  scope: 'internal' | 'external';
  command: string;
  /** Empty means: use the extension's persistent global storage path. */
  home: string;
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  permissions: string;
  autoSetupSandbox: boolean;
  /** User additions appended to the built-in developer instructions. */
  extraInstructions: string;
}

/**
 * Built-in developer instructions for Codex. They are intentionally terse:
 * environment/shell correctness plus file hygiene, which prevents the agent
 * from littering the workspace with patches, helper scripts and browser
 * profiles when it only needs to write a few files.
 */
export function buildDeveloperInstructions(
  platform: NodeJS.Platform,
  extra: string,
  project: string = ''
): string {
  const isWindows = platform === 'win32';
  const environment = isWindows
    ? [
        '- OS: Windows 11.',
        '- Shell: Windows PowerShell 5.1. There is no `pwsh`. Use PowerShell syntax and cmdlets',
        '  (Get-ChildItem, Set-Content -Encoding UTF8, New-Item, Remove-Item). Do not use',
        '  bash-only syntax unless the user explicitly asks for Git Bash.',
        '- When writing files from PowerShell, specify UTF-8 explicitly (Set-Content -Encoding UTF8);',
        '  avoid `>` redirection, which may produce UTF-16 files.',
      ]
    : [
        '- Shell: POSIX sh/bash. Use standard POSIX commands.',
        '- Write files as UTF-8.',
      ];

  const lines = [
    'You are running inside AgentBox, a VS Code sidebar coding agent. Follow these',
    'environment and workspace rules.',
    '',
    'Environment:',
    ...environment,
    '- Read and write files only inside the workspace root.',
    '',
    'Workflow:',
    '- Search/read the relevant files before editing; do not guess APIs or file contents.',
    '- Change only task-related code. Do not refactor or reformat unrelated files.',
    '- After changes, run the smallest relevant tests/build. Never claim success without',
    '  running them.',
    '- Do not add dependencies unless the task requires them, and explain why. Never revert',
    '  uncommitted user changes.',
    '- In the final reply, state what changed, verification results, and remaining risks.',
    '  Do not paste large file contents.',
    '',
    'File hygiene (important):',
    '- Create only files the task requires. Do not create patch files, helper scripts,',
    '  temporary dumps, screenshots, browser profiles, or scratch directories.',
    '- Do not create files such as `*.patch`, `apply*.py`, `dom.txt`, `len-test*.txt`,',
    '  `patch-test*.txt`, `preview.png`, `.chrome-profile`, or `.tmp` unless the user',
    '  explicitly asks for them.',
    '- For HTML/CSS/JS tasks, write the requested files directly (for example index.html',
    '  and required assets). Do not launch a browser, take screenshots, or create browser',
    '  profiles to preview the page unless the user asks.',
    '- If apply_patch fails, switch to a direct file write/edit (for example Set-Content).',
    '  Do not build a chain of helper scripts to apply patches.',
    '- Clean up temporary files you create; leave only files required by the task.',
    '- Keep changes minimal; do not add unrelated files.',
  ];

  const trimmedProject = project.trim();
  if (trimmedProject !== '') {
    lines.push(
      '',
      'Project instructions (AGENTS.md / AgentBox.md):',
      trimmedProject,
      '',
      'Project instructions may add conventions and commands, but they must not',
      'override the safety, file-hygiene, or verification rules above.'
    );
  }

  const trimmed = extra.trim();
  if (trimmed !== '') {
    lines.push('', 'Additional user instructions:', trimmed);
  }
  return lines.join('\n');
}

export interface CodexConfigOptions {
  settings: ModelSettings;
  workspaceRoot: string;
  apiKey: string;
  /** Persistent CODEX_HOME resolved by the extension. */
  home: string;
  limits?: Partial<Limits>;
  /** Contents of the workspace AGENTS.md / AgentBox.md, if present. */
  projectInstructions?: string;
}

/**
 * Parse a minimal .env file. Supports comments, blank lines, optional
 * `export ` prefix and single/double quoted values. Does not interpolate.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export function readEnvValue(
  content: string,
  key: string
): string | undefined {
  const value = parseEnvFile(content)[key];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Build the RuntimeConfig consumed by CodexRuntime. Secrets only travel
 * through `codex.env`; they are never written to settings/config.toml.
 */
export function buildCodexRuntimeConfig(
  options: CodexConfigOptions
): RuntimeConfig {
  const { settings } = options;
  if (options.apiKey.trim() === '') {
    throw new Error('API key is required for the selected model provider');
  }
  if (settings.baseUrl.trim() === '') {
    throw new Error('Model provider baseUrl is required');
  }
  if (settings.apiKeyEnv.trim() === '') {
    throw new Error('Model provider apiKeyEnv is required');
  }

  return {
    runtime: 'codex',
    workspaceRoot: options.workspaceRoot,
    limits: options.limits,
    codex: {
      command: settings.command,
      model: settings.model,
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      wireApi: 'responses',
      apiKeyEnv: settings.apiKeyEnv,
      home: options.home,
      scope: settings.scope,
      approvalPolicy: settings.approvalPolicy,
      permissions: settings.permissions,
      autoSetupSandbox: settings.autoSetupSandbox,
      developerInstructions: buildDeveloperInstructions(
        process.platform,
        settings.extraInstructions,
        options.projectInstructions ?? ''
      ),
      env: {
        [settings.apiKeyEnv]: options.apiKey,
      },
    },
  };
}
