import type { CommandInvocation, InvocationSummary } from '@yantra/protocol';

import type { AppRpc } from '../host/app-rpc.js';

/** Submit with one idempotency key; callers retry this function with the same invocation. */
export async function invokeCommand(
  rpc: AppRpc,
  invocation: CommandInvocation,
): Promise<InvocationSummary> {
  return rpc.request<InvocationSummary>('command.invoke', {
    invocation,
    displayed_effective: { settings: [], content: [] },
  });
}
