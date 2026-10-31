import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Workspace project instruction files, in precedence order. */
export const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'AgentBox.md'] as const;

/** Keep project instructions small; they are sent with every new thread. */
export const MAX_PROJECT_INSTRUCTION_CHARS = 8_000;

export interface ProjectInstructions {
  text?: string;
  path?: string;
  truncated: boolean;
}

/**
 * Read the first project instruction file found at the workspace root.
 * Missing/empty files yield undefined text. Content is trimmed and capped at
 * MAX_PROJECT_INSTRUCTION_CHARS to keep the developer prompt bounded.
 */
export function readProjectInstructions(
  workspaceRoot: string
): ProjectInstructions {
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const path = join(workspaceRoot, name);
    if (!existsSync(path)) continue;

    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    content = content.replace(/^﻿/, '').trimEnd();
    if (content === '') {
      return { path, truncated: false };
    }
    if (content.length > MAX_PROJECT_INSTRUCTION_CHARS) {
      return {
        text: `${content.slice(
          0,
          MAX_PROJECT_INSTRUCTION_CHARS
        )}\n\n… (truncated, ${content.length} chars)`,
        path,
        truncated: true,
      };
    }
    return { text: content, path, truncated: false };
  }
  return { truncated: false };
}
