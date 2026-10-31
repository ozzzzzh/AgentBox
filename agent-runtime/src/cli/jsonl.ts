import { createWriteStream, readFileSync, type WriteStream } from 'node:fs';
import type { AgentEvent } from '../types.js';

export type JsonlRecord = Record<string, unknown>;

export interface JsonlMeta {
  taskId?: string;
  [key: string]: unknown;
}

/** Write one JSON object per line. `undefined` filePath means stdout. */
export class JsonlWriter {
  private readonly stream: WriteStream | undefined;
  private closed = false;

  constructor(filePath?: string) {
    if (filePath !== undefined) {
      this.stream = createWriteStream(filePath, { encoding: 'utf8' });
    }
  }

  writeEvent(event: AgentEvent, meta?: JsonlMeta): void {
    this.writeRecord({ ...event, ...(meta ?? {}) });
  }

  writeRecord(record: JsonlRecord): void {
    if (this.closed) {
      throw new Error('JSONL writer is closed');
    }
    const line = `${JSON.stringify(record)}\n`;
    if (this.stream !== undefined) {
      this.stream.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.stream === undefined) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.stream?.end(() => resolve());
    });
  }
}

/**
 * Parse a JSONL file. Throws with the 1-based line number on malformed input.
 */
export function readJsonl(content: string): JsonlRecord[] {
  const records: JsonlRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('line is not a JSON object');
      }
      records.push(parsed as JsonlRecord);
    } catch (error) {
      throw new Error(
        `invalid JSONL at line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return records;
}

export function readJsonlFile(filePath: string): JsonlRecord[] {
  return readJsonl(readFileSync(filePath, 'utf8'));
}
