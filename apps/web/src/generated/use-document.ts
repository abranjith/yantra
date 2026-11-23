import { useQuery } from '@tanstack/react-query';

import { useRpc } from '../host/app-rpc.js';

import { readDocument, readFailure, type DocumentRead } from './read-document.js';
import type { SchemaLike } from './table-model.js';

/** A generated read: loading, failed with a reason, or a document that matches its schema. */
export type DocumentState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly document: unknown };

/**
 * Reads `read` and checks the document against `schema`. The host already
 * validates it, so a mismatch here means the app and the CLI disagree about
 * the contract, which is said out loud rather than rendered as empty cells.
 */
export function useDocument(
  read: DocumentRead & { readonly command: string },
  schema: SchemaLike,
): DocumentState {
  const rpc = useRpc();
  const query = useQuery({
    queryKey: ['generated-read', read.method, read.args ?? []],
    queryFn: () => readDocument(rpc, read),
  });
  if (query.isPending) return { status: 'loading' };
  if (query.isError) return { status: 'failed', message: readFailure(query.error) };
  if (!schema.safeParse(query.data).success) {
    return {
      status: 'failed',
      message: `yantra ${read.command} --json printed a document this app does not recognize.`,
    };
  }
  return { status: 'ready', document: query.data };
}
