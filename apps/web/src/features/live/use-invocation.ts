/**
 * Follows one app invocation (FEAT-067 TASK-005): its launch state, queue
 * position and run ID, from `read.invocation`. It is re-read on every
 * `invocation.changed` notice, not only its own: a queued item moves up when
 * another one starts, and notices carry no queue position.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvocationSummary } from '@yantra/protocol';
import { useEffect } from 'react';

import { useRpc } from '../../host/app-rpc.js';

/** The query key of one invocation. */
export function invocationKey(invocationId: string): readonly unknown[] {
  return ['invocation', invocationId];
}

/** The invocation, or undefined while loading or when `invocationId` is null. */
export function useInvocation(invocationId: string | null) {
  const rpc = useRpc();
  const client = useQueryClient();
  useEffect(() => {
    if (invocationId === null) return undefined;
    const refresh = (): void => {
      void client.invalidateQueries({ queryKey: invocationKey(invocationId) });
    };
    const offChanged = rpc.on('invocation.changed', refresh);
    const offResult = rpc.on('invocation.result', (params) => {
      if (params.invocation_id === invocationId) refresh();
    });
    return () => {
      offChanged();
      offResult();
    };
  }, [rpc, client, invocationId]);
  return useQuery({
    queryKey: invocationKey(invocationId ?? ''),
    enabled: invocationId !== null,
    queryFn: () =>
      rpc.request<InvocationSummary>('read.invocation', { invocation_id: invocationId }),
  });
}
