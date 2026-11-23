/**
 * Reading a command's `--json` document from the host (FEAT-065, FEAT-066).
 *
 * The host answers two ways, and every caller must know which:
 *
 * - a generic reader `read.<path>` takes `{args, options}` and answers with a
 *   `ReadResult` whose `value` is the document;
 * - `read.list` takes a typed query (`{target: 'workflows'}` or a Ledger
 *   query) and answers with the document itself.
 *
 * The host validates params strictly, so `{args: ['workflows']}` to
 * `read.list` is refused. Run mode and the Workflows page sent exactly that.
 */

import type { ListResult, ReadResult, WorkflowListQuery } from '@yantra/protocol';

import type { AppRpc } from '../host/app-rpc.js';
import { RpcCallError } from '../host/rpc-client.js';

/** What to read: a host method and the command line's positional arguments. */
export interface DocumentRead {
  readonly method: string;
  readonly args?: readonly string[];
}

/** Every saved workflow, as `yantra list workflows --json` prints it. */
export function listWorkflows(rpc: AppRpc): Promise<ListResult> {
  const query: WorkflowListQuery = { target: 'workflows' };
  return rpc.request<ListResult>('read.list', { ...query });
}

/**
 * The `--json` document `read` returns.
 *
 * @throws {Error} for a `read.list` target other than `workflows`: the Ledger
 *   pages runs through `data/runs.ts`, not here.
 */
export async function readDocument(rpc: AppRpc, read: DocumentRead): Promise<unknown> {
  if (read.method === 'read.list') {
    if (read.args?.length !== 1 || read.args[0] !== 'workflows') {
      throw new Error(`read.list here lists workflows only; got ${JSON.stringify(read.args)}.`);
    }
    return listWorkflows(rpc);
  }
  const result = await rpc.request<ReadResult>(
    read.method,
    read.args === undefined || read.args.length === 0 ? {} : { args: [...read.args] },
  );
  return result.value;
}

/** A read failure in words: the host's message, then its remediation when it gave one. */
export function readFailure(error: unknown): string {
  if (error instanceof RpcCallError && error.remediation !== undefined) {
    return `${error.message} ${error.remediation}`;
  }
  return error instanceof Error ? error.message : String(error);
}
