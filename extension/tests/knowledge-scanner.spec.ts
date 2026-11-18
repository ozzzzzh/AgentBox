import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectionForRoot,
  scanWorkspace,
  type ScannerIo,
  type ScannerStat,
} from '../src/knowledge/scanner';

const ROOT = 'D:\\ws';

interface FakeFile {
  content: string | Uint8Array;
  size?: number;
  mtimeMs?: number;
  symlink?: boolean;
}

function fakeIo(files: Record<string, FakeFile>): ScannerIo {
  const paths = Object.keys(files);
  return {
    async findFiles() {
      return paths;
    },
    async stat(path): Promise<ScannerStat> {
      const file = files[path];
      if (file === undefined) throw new Error('missing');
      const bytes =
        typeof file.content === 'string'
          ? Buffer.byteLength(file.content, 'utf8')
          : file.content.length;
      return {
        size: file.size ?? bytes,
        mtimeMs: file.mtimeMs ?? 1_760_000_000_000,
        isFile: true,
        isSymbolicLink: file.symlink === true,
      };
    },
    async readFile(path) {
      const file = files[path];
      if (file === undefined) throw new Error('missing');
      return typeof file.content === 'string'
        ? new TextEncoder().encode(file.content)
        : file.content;
    },
  };
}

describe('knowledge scanner', () => {
  it('filters ignored, secret, binary and oversized files', async () => {
    const files: Record<string, FakeFile> = {
      [join(ROOT, 'docs', 'a.md')]: { content: '# A\r\n\r\nbody\r\n' },
      [join(ROOT, 'src', 'a.ts')]: { content: 'export const a = 1;\n' },
      [join(ROOT, 'node_modules', 'x.md')]: { content: '# dependency' },
      [join(ROOT, '.env')]: { content: 'TOKEN=secret' },
      [join(ROOT, 'image.md')]: { content: new Uint8Array([1, 0, 2]) },
      [join(ROOT, 'big.md')]: { content: '# big', size: 2 * 1024 * 1024 },
      [join(ROOT, 'link.md')]: { content: '# link', symlink: true },
    };
    const result = await scanWorkspace({
      root: ROOT,
      io: fakeIo(files),
      maxFileBytes: 1024,
    });
    expect(result.documents.map((item) => item.path)).toEqual([
      'docs/a.md',
      'src/a.ts',
    ]);
    expect(result.documents[0]?.content).toBe('# A\n\nbody\n');
    expect(result.skipped.map((item) => item.reason)).toContain('binary file');
    expect(result.skipped.map((item) => item.reason)).toContain('file too large');
  });

  it('derives a stable collection from the workspace root', async () => {
    const result = await scanWorkspace({
      root: ROOT,
      io: fakeIo({
        [join(ROOT, 'a.md')]: { content: '# A' },
      }),
    });
    expect(result.collection).toMatch(/^ws_[0-9a-f]{16}$/);
    expect(result.collection).toBe(collectionForRoot(ROOT));
  });

  it('reports invalid UTF-8', async () => {
    const result = await scanWorkspace({
      root: ROOT,
      io: fakeIo({
        [join(ROOT, 'bad.md')]: { content: new Uint8Array([0xff, 0xfe]) },
      }),
    });
    expect(result.documents).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('invalid UTF-8');
  });
});
