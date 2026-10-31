export interface ActiveContext {
  /** Workspace-relative path, or undefined when no file editor is active. */
  file?: string;
  selection?: {
    startLine: number;
    endLine: number;
    preview: string;
  };
}

export interface ContextInput {
  filePath?: string;
  languageId?: string;
  fileContent?: string;
  selection?: {
    text: string;
    startLine: number;
    endLine: number;
  };
  maxFileChars?: number;
  maxSelectionChars?: number;
}

export function buildContextText(input: ContextInput): string | undefined {
  const maxFileChars = input.maxFileChars ?? 12_000;
  const maxSelectionChars = input.maxSelectionChars ?? 8_000;
  const parts: string[] = [];

  if (input.filePath !== undefined && input.fileContent !== undefined) {
    const content =
      input.fileContent.length <= maxFileChars
        ? input.fileContent
        : `${input.fileContent.slice(0, maxFileChars)}\n… (truncated, ${input.fileContent.length} chars)`;
    const language = input.languageId ?? 'text';
    parts.push(
      `## Current file\npath: ${input.filePath}\n\n\`\`\`${language}\n${content}\n\`\`\``
    );
  }

  if (input.selection !== undefined) {
    const selected =
      input.selection.text.length <= maxSelectionChars
        ? input.selection.text
        : `${input.selection.text.slice(0, maxSelectionChars)}\n… (truncated, ${input.selection.text.length} chars)`;
    parts.push(
      `## Selection (lines ${input.selection.startLine}-${input.selection.endLine})\n\n\`\`\`\n${selected}\n\`\`\``
    );
  }

  return parts.length === 0 ? undefined : parts.join('\n\n');
}
