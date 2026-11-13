/**
 * A separate process that tries to reserve one invocation (FEAT-065 TASK-014
 * concurrency test). Usage: `reserve-child.ts <root> <lockPath> <id>`; prints
 * `{"reserved":boolean}` or `{"error":name}` on stdout.
 */

import { FileInvocationStore } from '../../../src/app-host/invocation-store.js';

const [root, lockPath, id] = process.argv.slice(2);
if (root === undefined || lockPath === undefined || id === undefined) {
  process.stdout.write(JSON.stringify({ error: 'usage' }));
} else {
  const store = new FileInvocationStore({ root, lockPath, lockWaitMs: 20_000 });
  try {
    const outcome = await store.reserve(id, (record) => `run-${record.invocation_id}`);
    process.stdout.write(JSON.stringify({ reserved: outcome.reserved }));
  } catch (error) {
    const detail = error as NodeJS.ErrnoException;
    process.stdout.write(
      JSON.stringify({ error: detail.name, code: detail.code ?? null, message: detail.message }),
    );
  }
}
