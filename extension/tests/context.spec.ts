import { describe, expect, it } from 'vitest';
import { buildContextText } from '../src/context';

describe('buildContextText', () => {
  it('returns undefined when there is no context', () => {
    expect(buildContextText({})).toBeUndefined();
  });

  it('wraps the active file in a fenced block', () => {
    const text = buildContextText({
      filePath: 'src/a.ts',
      languageId: 'typescript',
      fileContent: 'const a = 1;',
    });

    expect(text).toBe(
      '## Current file\npath: src/a.ts\n\n```typescript\nconst a = 1;\n```'
    );
  });

  it('includes the selection with 1-based line numbers', () => {
    const text = buildContextText({
      selection: { text: 'line 10\nline 11', startLine: 10, endLine: 11 },
    });

    expect(text).toContain('## Selection (lines 10-11)');
    expect(text).toContain('line 10\nline 11');
  });

  it('truncates large files and selections with a notice', () => {
    const text = buildContextText({
      filePath: 'big.txt',
      fileContent: 'abcdef',
      maxFileChars: 3,
      selection: { text: 'uvwxyz', startLine: 1, endLine: 1 },
      maxSelectionChars: 2,
    });

    expect(text).toContain('abc\n… (truncated, 6 chars)');
    expect(text).toContain('uv\n… (truncated, 6 chars)');
  });

  it('joins file and selection in a stable order', () => {
    const text = buildContextText({
      filePath: 'a.ts',
      fileContent: 'a',
      selection: { text: 'b', startLine: 2, endLine: 2 },
    });

    expect(text?.indexOf('## Current file')).toBe(0);
    expect(text?.indexOf('## Selection')).toBeGreaterThan(0);
  });
});
