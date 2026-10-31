import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertInsideWorkspace } from '../security/paths.js';
import type { CheckDefinition, TaskCheckResult } from './types.js';

export interface CheckContext {
  workspaceRoot: string;
  text: string;
  approvals: number;
}

function truncate(value: string, max = 500): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function resolveFile(context: CheckContext, path: string): string {
  return assertInsideWorkspace(context.workspaceRoot, path);
}

function readText(context: CheckContext, path: string): string {
  return readFileSync(resolveFile(context, path), 'utf8');
}

function contains(haystack: string, needle: string, ignoreCase: boolean): boolean {
  return ignoreCase
    ? haystack.toLowerCase().includes(needle.toLowerCase())
    : haystack.includes(needle);
}

function runCommand(
  context: CheckContext,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): TaskCheckResult {
  const result = spawnSync(command, args, {
    cwd: resolve(context.workspaceRoot, cwd),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const ok = result.status === 0;
  if (result.error) {
    return {
      ok: false,
      type: 'command',
      detail: `${command} failed: ${result.error.message}`,
    };
  }
  return {
    ok,
    type: 'command',
    detail: truncate(`${command} exit=${String(result.status)} ${output}`),
  };
}

export function runCheck(
  check: CheckDefinition,
  context: CheckContext
): TaskCheckResult {
  switch (check.type) {
    case 'text-contains-all': {
      const ignoreCase = check.ignoreCase ?? true;
      const missing = check.values.filter(
        (value) => !contains(context.text, value, ignoreCase)
      );
      return {
        ok: missing.length === 0,
        type: check.type,
        detail:
          missing.length === 0
            ? `found: ${check.values.join(', ')}`
            : `missing in text: ${missing.join(', ')}`,
      };
    }

    case 'file-contains': {
      try {
        const content = readText(context, check.path);
        const ok = contains(
          content,
          check.value,
          check.ignoreCase ?? false
        );
        return {
          ok,
          type: check.type,
          detail: ok
            ? `${check.path} contains expected value`
            : `${check.path} does not contain ${JSON.stringify(check.value)}`,
        };
      } catch (error) {
        return {
          ok: false,
          type: check.type,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }

    case 'file-not-contains': {
      try {
        const content = readText(context, check.path);
        const found = contains(
          content,
          check.value,
          check.ignoreCase ?? false
        );
        return {
          ok: !found,
          type: check.type,
          detail: found
            ? `${check.path} still contains ${JSON.stringify(check.value)}`
            : `${check.path} no longer contains value`,
        };
      } catch (error) {
        return {
          ok: false,
          type: check.type,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }

    case 'file-exists': {
      try {
        const exists = existsSync(resolveFile(context, check.path));
        return {
          ok: exists,
          type: check.type,
          detail: exists ? `${check.path} exists` : `${check.path} is missing`,
        };
      } catch (error) {
        return {
          ok: false,
          type: check.type,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }

    case 'python-compile':
      try {
        const file = resolveFile(context, check.path);
        return runCommand(
          context,
          'python',
          ['-m', 'py_compile', file],
          '.',
          30_000
        );
      } catch (error) {
        return {
          ok: false,
          type: check.type,
          detail: error instanceof Error ? error.message : String(error),
        };
      }

    case 'command':
      try {
        const file = resolveFile(context, check.cwd ?? '.');
        return runCommand(
          context,
          check.command,
          check.args ?? [],
          file,
          check.timeoutMs ?? 60_000
        );
      } catch (error) {
        return {
          ok: false,
          type: check.type,
          detail: error instanceof Error ? error.message : String(error),
        };
      }

    case 'all': {
      const results = check.checks.map((entry) => runCheck(entry, context));
      return {
        ok: results.every((entry) => entry.ok),
        type: check.type,
        detail: results
          .map((entry) => `${entry.ok ? 'ok' : 'fail'}: ${entry.detail}`)
          .join('; '),
      };
    }

    case 'approval-and-file-exists': {
      try {
        const exists = existsSync(resolveFile(context, check.path));
        const ok = exists && context.approvals > 0;
        return {
          ok,
          type: check.type,
          detail: `fileExists=${exists} approvals=${context.approvals}`,
        };
      } catch (error) {
        return {
          ok: false,
          type: check.type,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }

    default: {
      const exhaustive: never = check;
      return {
        ok: false,
        type: String(exhaustive),
        detail: 'unknown check type',
      };
    }
  }
}
