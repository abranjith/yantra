import type { ResourceLockOptions } from '../locks/resource-lock.js';

import type { ExecutionReceiptDraft } from './execution-receipt.js';
/** Safe command-path metadata for stores created below an invocation boundary. */
export function receiptLockOptions(
  receipt: ExecutionReceiptDraft | undefined,
): ResourceLockOptions {
  return receipt
    ? {
        owner: {
          pid: process.pid,
          command: `yantra ${receipt.command.join(' ')}`,
          started_at: new Date().toISOString(),
          surface: receipt.invoked_by,
        },
      }
    : {};
}
