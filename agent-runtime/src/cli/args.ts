export type ApprovalMode = 'allow' | 'deny';

export interface RunOptions {
  runtime: 'codex' | 'opencode';
  workspace: string;
  prompt?: string;
  promptFile?: string;
  out?: string;
  taskId?: string;
  context?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  envFile?: string;
  home?: string;
  command?: string;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  permissions?: string;
  autoSetupSandbox?: boolean;
  turnTimeoutMs?: number;
  maxSteps?: number;
  approval: ApprovalMode;
}

export interface ReplayOptions {
  input: string;
}

export interface EvalOptions {
  runtime: 'codex' | 'opencode';
  tasks: string;
  outDir?: string;
  only?: string[];
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  envFile?: string;
  home?: string;
  command?: string;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  permissions?: string;
  autoSetupSandbox?: boolean;
  turnTimeoutMs?: number;
  maxSteps?: number;
  approval: ApprovalMode;
}

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'run'; options: RunOptions }
  | { kind: 'replay'; options: ReplayOptions }
  | { kind: 'eval'; options: EvalOptions };

export const USAGE = `AgentBox CLI

Usage:
  agentbox run --workspace <dir> --prompt <text> [options]
  agentbox replay --in <events.jsonl>
  agentbox eval --tasks <tasks.json> [options]

Run options:
  --runtime codex|opencode       default: codex
  --workspace <dir>              required
  --prompt <text>               required unless --prompt-file
  --prompt-file <path>
  --out <events.jsonl>          default: stdout
  --task-id <id>
  --context <text>
  --provider <id>
  --model <id>
  --base-url <url>
  --api-key-env <name>          default: MODEL_API_KEY
  --env-file <path>             optional .env for local testing
  --home <dir>                  persistent CODEX_HOME
  --command <path>              codex executable
  --approval-policy <mode>      untrusted|on-request|never
  --permissions <profile>       default: :workspace
  --auto-setup-sandbox / --no-auto-setup-sandbox
  --turn-timeout-ms <n>
  --max-steps <n>
  --approval allow|deny         default: deny

Eval options:
  --tasks <tasks.json>          default: eval/tasks.json
  --out-dir <dir>               default: eval/results/<timestamp>
  --task <id>                   repeatable filter
  --runtime codex|opencode      default: codex
  --provider/model/base-url/api-key-env/env-file/home/command
  --approval-policy / --permissions / --auto-setup-sandbox
  --turn-timeout-ms / --max-steps
  --approval allow|deny        default: allow
`;

function fail(message: string): never {
  throw new Error(`${message}\n\n${USAGE}`);
}

function readValue(args: string[], index: number, name: string): {
  value: string;
  next: number;
} {
  const current = args[index];
  const prefix = `--${name}=`;
  if (current.startsWith(prefix)) {
    return { value: current.slice(prefix.length), next: index + 1 };
  }
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
    fail(`missing value for --${name}`);
  }
  return { value: args[index + 1], next: index + 2 };
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`--${name} must be a positive integer`);
  }
  return parsed;
}

function parseRun(args: string[]): RunOptions {
  const options: RunOptions = {
    runtime: 'codex',
    workspace: '',
    approval: 'deny',
  };

  for (let i = 0; i < args.length; ) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return fail('help requested');

    if (arg === '--runtime') {
      const read = readValue(args, i, 'runtime');
      if (read.value !== 'codex' && read.value !== 'opencode') {
        fail('--runtime must be codex or opencode');
      }
      options.runtime = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--runtime=')) {
      const read = readValue(args, i, 'runtime');
      if (read.value !== 'codex' && read.value !== 'opencode') {
        fail('--runtime must be codex or opencode');
      }
      options.runtime = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--workspace') {
      const read = readValue(args, i, 'workspace');
      options.workspace = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--workspace=')) {
      const read = readValue(args, i, 'workspace');
      options.workspace = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--prompt') {
      const read = readValue(args, i, 'prompt');
      options.prompt = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--prompt=')) {
      const read = readValue(args, i, 'prompt');
      options.prompt = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--prompt-file') {
      const read = readValue(args, i, 'prompt-file');
      options.promptFile = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--prompt-file=')) {
      const read = readValue(args, i, 'prompt-file');
      options.promptFile = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--out') {
      const read = readValue(args, i, 'out');
      options.out = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--out=')) {
      const read = readValue(args, i, 'out');
      options.out = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--task-id') {
      const read = readValue(args, i, 'task-id');
      options.taskId = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--task-id=')) {
      const read = readValue(args, i, 'task-id');
      options.taskId = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--context') {
      const read = readValue(args, i, 'context');
      options.context = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--context=')) {
      const read = readValue(args, i, 'context');
      options.context = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--provider') {
      const read = readValue(args, i, 'provider');
      options.provider = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--provider=')) {
      const read = readValue(args, i, 'provider');
      options.provider = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--model') {
      const read = readValue(args, i, 'model');
      options.model = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--model=')) {
      const read = readValue(args, i, 'model');
      options.model = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--base-url') {
      const read = readValue(args, i, 'base-url');
      options.baseUrl = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      const read = readValue(args, i, 'base-url');
      options.baseUrl = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--api-key-env') {
      const read = readValue(args, i, 'api-key-env');
      options.apiKeyEnv = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--api-key-env=')) {
      const read = readValue(args, i, 'api-key-env');
      options.apiKeyEnv = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--env-file') {
      const read = readValue(args, i, 'env-file');
      options.envFile = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--env-file=')) {
      const read = readValue(args, i, 'env-file');
      options.envFile = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--home') {
      const read = readValue(args, i, 'home');
      options.home = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--home=')) {
      const read = readValue(args, i, 'home');
      options.home = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--command') {
      const read = readValue(args, i, 'command');
      options.command = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--command=')) {
      const read = readValue(args, i, 'command');
      options.command = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--approval-policy') {
      const read = readValue(args, i, 'approval-policy');
      if (
        read.value !== 'untrusted' &&
        read.value !== 'on-request' &&
        read.value !== 'never'
      ) {
        fail('--approval-policy must be untrusted, on-request or never');
      }
      options.approvalPolicy = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--approval-policy=')) {
      const read = readValue(args, i, 'approval-policy');
      if (
        read.value !== 'untrusted' &&
        read.value !== 'on-request' &&
        read.value !== 'never'
      ) {
        fail('--approval-policy must be untrusted, on-request or never');
      }
      options.approvalPolicy = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--permissions') {
      const read = readValue(args, i, 'permissions');
      options.permissions = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--permissions=')) {
      const read = readValue(args, i, 'permissions');
      options.permissions = read.value;
      i = read.next;
      continue;
    }

    if (arg === '--auto-setup-sandbox') {
      options.autoSetupSandbox = true;
      i += 1;
      continue;
    }
    if (arg === '--no-auto-setup-sandbox') {
      options.autoSetupSandbox = false;
      i += 1;
      continue;
    }

    if (arg === '--turn-timeout-ms') {
      const read = readValue(args, i, 'turn-timeout-ms');
      options.turnTimeoutMs = positiveInteger('turn-timeout-ms', read.value);
      i = read.next;
      continue;
    }
    if (arg.startsWith('--turn-timeout-ms=')) {
      const read = readValue(args, i, 'turn-timeout-ms');
      options.turnTimeoutMs = positiveInteger('turn-timeout-ms', read.value);
      i = read.next;
      continue;
    }

    if (arg === '--max-steps') {
      const read = readValue(args, i, 'max-steps');
      options.maxSteps = positiveInteger('max-steps', read.value);
      i = read.next;
      continue;
    }
    if (arg.startsWith('--max-steps=')) {
      const read = readValue(args, i, 'max-steps');
      options.maxSteps = positiveInteger('max-steps', read.value);
      i = read.next;
      continue;
    }

    if (arg === '--approval') {
      const read = readValue(args, i, 'approval');
      if (read.value !== 'allow' && read.value !== 'deny') {
        fail('--approval must be allow or deny');
      }
      options.approval = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--approval=')) {
      const read = readValue(args, i, 'approval');
      if (read.value !== 'allow' && read.value !== 'deny') {
        fail('--approval must be allow or deny');
      }
      options.approval = read.value;
      i = read.next;
      continue;
    }

    fail(`unknown option: ${arg}`);
  }

  if (options.workspace === '') fail('--workspace is required');
  if ((options.prompt === undefined) === (options.promptFile === undefined)) {
    fail('provide exactly one of --prompt or --prompt-file');
  }
  if (options.prompt !== undefined && options.prompt.trim() === '') {
    fail('--prompt must not be empty');
  }

  return options;
}

function parseReplay(args: string[]): ReplayOptions {
  let input: string | undefined;
  for (let i = 0; i < args.length; ) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') fail('help requested');
    if (arg === '--in') {
      const read = readValue(args, i, 'in');
      input = read.value;
      i = read.next;
      continue;
    }
    if (arg.startsWith('--in=')) {
      const read = readValue(args, i, 'in');
      input = read.value;
      i = read.next;
      continue;
    }
    fail(`unknown option: ${arg}`);
  }
  if (input === undefined || input === '') fail('--in is required');
  return { input };
}

function parseEval(args: string[]): EvalOptions {
  const options: EvalOptions = {
    runtime: 'codex',
    tasks: 'eval/tasks.json',
    approval: 'allow',
  };

  const read = (index: number, name: string) =>
    readValue(args, index, name);

  for (let i = 0; i < args.length; ) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') fail('help requested');

    if (arg === '--runtime' || arg.startsWith('--runtime=')) {
      const value = read(i, 'runtime');
      if (value.value !== 'codex' && value.value !== 'opencode') {
        fail('--runtime must be codex or opencode');
      }
      options.runtime = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--tasks' || arg.startsWith('--tasks=')) {
      const value = read(i, 'tasks');
      options.tasks = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--out-dir' || arg.startsWith('--out-dir=')) {
      const value = read(i, 'out-dir');
      options.outDir = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--task' || arg.startsWith('--task=')) {
      const value = read(i, 'task');
      options.only = [...(options.only ?? []), value.value];
      i = value.next;
      continue;
    }
    if (arg === '--provider' || arg.startsWith('--provider=')) {
      const value = read(i, 'provider');
      options.provider = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--model' || arg.startsWith('--model=')) {
      const value = read(i, 'model');
      options.model = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--base-url' || arg.startsWith('--base-url=')) {
      const value = read(i, 'base-url');
      options.baseUrl = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--api-key-env' || arg.startsWith('--api-key-env=')) {
      const value = read(i, 'api-key-env');
      options.apiKeyEnv = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--env-file' || arg.startsWith('--env-file=')) {
      const value = read(i, 'env-file');
      options.envFile = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--home' || arg.startsWith('--home=')) {
      const value = read(i, 'home');
      options.home = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--command' || arg.startsWith('--command=')) {
      const value = read(i, 'command');
      options.command = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--approval-policy' || arg.startsWith('--approval-policy=')) {
      const value = read(i, 'approval-policy');
      if (
        value.value !== 'untrusted' &&
        value.value !== 'on-request' &&
        value.value !== 'never'
      ) {
        fail('--approval-policy must be untrusted, on-request or never');
      }
      options.approvalPolicy = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--permissions' || arg.startsWith('--permissions=')) {
      const value = read(i, 'permissions');
      options.permissions = value.value;
      i = value.next;
      continue;
    }
    if (arg === '--auto-setup-sandbox') {
      options.autoSetupSandbox = true;
      i += 1;
      continue;
    }
    if (arg === '--no-auto-setup-sandbox') {
      options.autoSetupSandbox = false;
      i += 1;
      continue;
    }
    if (arg === '--turn-timeout-ms' || arg.startsWith('--turn-timeout-ms=')) {
      const value = read(i, 'turn-timeout-ms');
      options.turnTimeoutMs = positiveInteger('turn-timeout-ms', value.value);
      i = value.next;
      continue;
    }
    if (arg === '--max-steps' || arg.startsWith('--max-steps=')) {
      const value = read(i, 'max-steps');
      options.maxSteps = positiveInteger('max-steps', value.value);
      i = value.next;
      continue;
    }
    if (arg === '--approval' || arg.startsWith('--approval=')) {
      const value = read(i, 'approval');
      if (value.value !== 'allow' && value.value !== 'deny') {
        fail('--approval must be allow or deny');
      }
      options.approval = value.value;
      i = value.next;
      continue;
    }
    fail(`unknown option: ${arg}`);
  }

  return options;
}

export function parseArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return { kind: 'help' };
  }
  if (command === 'run') {
    return { kind: 'run', options: parseRun(rest) };
  }
  if (command === 'replay') {
    return { kind: 'replay', options: parseReplay(rest) };
  }
  if (command === 'eval') {
    return { kind: 'eval', options: parseEval(rest) };
  }
  return fail(`unknown command: ${command}`);
}
