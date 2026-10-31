import { isAbsolute, relative, sep } from 'node:path';
import type {
  ApprovalPolicyResult,
  ApprovalPrompt,
} from './controller';

/** Default deny patterns for files the agent should not create. */
export const DEFAULT_DENY_WRITE: string[] = [
  '**/.chrome-profile/**',
  '**/*.patch',
  '**/dom.txt',
  '**/preview.png',
  '**/len-test*',
  '**/patch-test*',
  '**/apply-*.py',
  '**/.tmp/**',
];

const HARD_COMMAND_MARKERS = [
  '--user-data-dir',
  '.chrome-profile',
  'preview.png',
  'dom.txt',
  'len-test',
  'patch-test',
];

const CONFIRM_COMMAND_PATTERNS = [
  /\bchrome\b/i,
  /\bmsedge\b/i,
  /\bplaywright\b/i,
  /\bpuppeteer\b/i,
  /\bheadless\b/i,
  /\bscreenshot\b/i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  pattern += '$';
  return new RegExp(pattern, process.platform === 'win32' ? 'i' : '');
}

function normalizePath(value: string, workspaceRoot: string): string {
  let path = value.trim();
  if (isAbsolute(path)) path = relative(workspaceRoot, path);
  path = path.split(sep).join('/').replace(/^\.\//, '');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function collectPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') {
      paths.push(value.trim());
    }
  };

  add(args.grantRoot);
  add(args.path);

  for (const key of ['fileChanges', 'changes']) {
    const value = args[key];
    if (Array.isArray(value)) {
      for (const change of value) {
        if (typeof change === 'string') add(change);
        else if (isRecord(change)) {
          add(change.path);
          add(change.move_path);
        }
      }
    } else if (isRecord(value)) {
      for (const key of Object.keys(value)) add(key);
    }
  }

  return paths;
}

function commandText(args: Record<string, unknown>): string {
  const command = args.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) {
    return command.filter((part) => typeof part === 'string').join(' ');
  }
  return '';
}

function matchDenyPattern(
  path: string,
  patterns: string[]
): string | undefined {
  const basename = path.split('/').pop() ?? path;
  for (const pattern of patterns) {
    const regex = globToRegExp(
      process.platform === 'win32' ? pattern.toLowerCase() : pattern
    );
    if (regex.test(path)) return pattern;
    // A basename-only pattern such as "*.patch" should also match nested files.
    if (!pattern.includes('/') && regex.test(basename)) return pattern;
  }
  return undefined;
}

/**
 * Approval-phase file policy.
 *
 * Deny known junk artifacts (patch/helper/browser-profile files) when paths are
 * visible in the approval payload; ask for confirmation when a command looks
 * like it will launch a browser or take screenshots. This is a safety net, not
 * a replacement for the sandbox: it only runs when Codex requests approval.
 */
export function evaluateApprovalPolicy(
  prompt: ApprovalPrompt,
  workspaceRoot: string,
  denyPatterns: string[] = DEFAULT_DENY_WRITE
): ApprovalPolicyResult {
  const args = isRecord(prompt.args) ? prompt.args : {};

  for (const rawPath of collectPaths(args)) {
    const path = normalizePath(rawPath, workspaceRoot);
    const matched = matchDenyPattern(path, denyPatterns);
    if (matched !== undefined) {
      return {
        decision: 'deny',
        reason: `路径 ${path} 命中文件策略禁止写入（${matched}）`,
      };
    }
  }

  const command = commandText(args).toLowerCase();
  if (command !== '') {
    for (const marker of HARD_COMMAND_MARKERS) {
      if (command.includes(marker)) {
        return {
          decision: 'deny',
          reason: `命令包含受限产物标记（${marker}）`,
        };
      }
    }
    if (CONFIRM_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
      return {
        decision: 'confirm',
        reason:
          '命令可能启动浏览器/生成截图或临时产物；请确认这不是不必要的预览。',
      };
    }
  }

  return { decision: 'allow' };
}
