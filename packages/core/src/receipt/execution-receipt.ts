import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import {
  ExecutionReceiptSchema,
  type ContentIdentity,
  type ExecutionReceipt,
} from '@yantra/protocol';

import { writeFileAtomic } from '../fs/atomic-write.js';

export type ExecutionReceiptDraft = Omit<ExecutionReceipt, 'run_id' | 'sequence' | 'written_at'>;
/** Publish an immutable receipt. Concurrent resumes compete by exclusive publication. */
export async function writeExecutionReceipt(
  runDir: string,
  draft: ExecutionReceiptDraft,
  options: { readonly resume?: boolean } = {},
): Promise<{ readonly path: string; readonly receipt: ExecutionReceipt }> {
  const runId = basename(runDir);
  for (let sequence = options.resume ? 1 : 0; ; sequence++) {
    const receipt = ExecutionReceiptSchema.parse({
      ...draft,
      run_id: runId,
      sequence,
      written_at: new Date().toISOString(),
      settings: [...draft.settings].sort((a, b) => a.key.localeCompare(b.key)),
    });
    const path = join(
      runDir,
      sequence === 0 ? 'execution-receipt.json' : `execution-receipt.resume-${sequence}.json`,
    );
    try {
      await writeFileAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o600,
        fsync: true,
        exclusive: true,
      });
      return { path, receipt };
    } catch (error) {
      if (options.resume && (error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
}
/** Hash streamed file bytes, never a decoded/re-serialized version. */
export async function contentIdentity(
  kind: ContentIdentity['kind'],
  path: string,
): Promise<ContentIdentity> {
  if (!isAbsolute(path)) throw new Error('Content identity path must be absolute');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { kind, path, sha256: hash.digest('hex') };
}
