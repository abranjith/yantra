/**
 * `receipt_written` (FEAT-063 × FEAT-072): the run records that its execution
 * receipt exists, with the SHA-256 of the receipt file's exact bytes, right
 * after the receipt is atomically written.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { RunEventOf } from '@yantra/protocol';

import { RunEventLogError } from './log.js';
import type { RunEventStream } from './stream.js';

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const RECEIPT_FILE = /^execution-receipt(?:\.resume-[1-9]\d*)?\.json$/u;

/**
 * Emits `receipt_written` for a receipt file.
 *
 * @param stream The run's event stream.
 * @param receipt `sha256` is the lowercase hex digest of the file bytes;
 *   `path` the receipt's run-relative file name (defaults to the first-run
 *   `execution-receipt.json`; a resume writes `execution-receipt.resume-<n>.json`).
 * @throws {RunEventLogError} `RUN_EVENT_INVALID` for a digest that is not 64
 *   lowercase hex characters or a file name that is not a receipt, before
 *   anything is emitted.
 */
export function emitReceiptWritten(
  stream: RunEventStream,
  receipt: { readonly sha256: string; readonly path?: string; readonly at?: string },
): RunEventOf<'receipt_written'> {
  const path = receipt.path ?? 'execution-receipt.json';
  if (!SHA256_HEX.test(receipt.sha256)) {
    throw new RunEventLogError(
      'RUN_EVENT_INVALID',
      'A receipt digest must be 64 lowercase hex characters.',
    );
  }
  if (!RECEIPT_FILE.test(path)) {
    throw new RunEventLogError('RUN_EVENT_INVALID', 'Not an execution receipt file name.');
  }
  const event: RunEventOf<'receipt_written'> = {
    kind: 'receipt_written',
    path,
    sha256: receipt.sha256,
    at: receipt.at ?? new Date().toISOString(),
  };
  stream.emit(event);
  return event;
}

/**
 * Hashes the receipt file `writeExecutionReceipt` just wrote and records it.
 *
 * @param stream The run's event stream.
 * @param absolutePath The written receipt (`writeExecutionReceipt(...).path`).
 */
export async function recordReceiptWritten(
  stream: RunEventStream,
  absolutePath: string,
): Promise<RunEventOf<'receipt_written'>> {
  const sha256 = createHash('sha256')
    .update(await readFile(absolutePath))
    .digest('hex');
  return emitReceiptWritten(stream, { sha256, path: basename(absolutePath) });
}
