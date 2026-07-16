import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ToolAuditEntry as ToolAuditEntrySchema, type ToolAuditEntryType } from '@yantra/protocol';
import pino from 'pino';

const logger = pino({ name: 'tool-call-writer', level: process.env.LOG_LEVEL ?? 'info' });

/** Tool audit data supplied by callers; the writer exclusively owns `seq`. */
export type ToolAuditEntryInput = Omit<ToolAuditEntryType, 'seq'>;

/**
 * Crash-conscious append-only writer for the stable `tool-calls.jsonl` projection.
 *
 * Calls are serialized through one promise chain, each line is appended in a
 * single write and synced before the append resolves, and sequence numbers are
 * allocated only by this instance.
 */
export class ToolCallWriter {
  private file: FileHandle | null = null;
  private opening: Promise<FileHandle> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private nextSeq = 0;
  private closed = false;

  public constructor(private readonly filePath: string) {}

  /**
   * Creates a writer for `<runDir>/tool-calls.jsonl`.
   *
   * @param runDir Owning run directory.
   * @returns A fresh single-owner writer starting at sequence zero.
   */
  public static forRun(runDir: string): ToolCallWriter {
    return new ToolCallWriter(join(runDir, 'tool-calls.jsonl'));
  }

  /**
   * Appends and flushes one validated lifecycle entry.
   *
   * @param input Stable entry fields other than the writer-owned sequence.
   * @returns The exact validated entry written to disk.
   */
  public append(input: ToolAuditEntryInput): Promise<ToolAuditEntryType> {
    if (this.closed) {
      return Promise.reject(new Error('Cannot append to a closed tool-call writer.'));
    }
    const entry = ToolAuditEntrySchema.parse({ ...input, seq: this.nextSeq++ });
    const operation = this.tail.then(async () => {
      const file = await this.ensureOpen();
      await file.write(`${JSON.stringify(entry)}\n`);
      await file.sync();
      logger.debug({ seq: entry.seq, phase: entry.phase, tool: entry.tool }, 'tool call persisted');
    });
    this.tail = operation;
    return operation.then(() => entry);
  }

  /** Waits for all appends and closes the file handle. Idempotent. */
  public async close(): Promise<void> {
    if (this.closed) {
      await this.tail;
      return;
    }
    this.closed = true;
    await this.tail;
    await this.file?.close();
    this.file = null;
  }

  private async ensureOpen(): Promise<FileHandle> {
    if (this.file !== null) return this.file;
    if (this.opening !== null) return this.opening;
    this.opening = (async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const file = await open(this.filePath, 'a', 0o600);
      this.file = file;
      this.opening = null;
      return file;
    })();
    return this.opening;
  }
}
