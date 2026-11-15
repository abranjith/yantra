/**
 * The Do gate (FEAT-067 TASK-012): `do` needs a model, so the composer asks
 * the host whether a provider session could open now, and when not, says why
 * and offers the real command that fixes it as a copyable CLI twin.
 * FEAT-071's Credentials and Onboarding will link here once they exist.
 */

import { useQuery } from '@tanstack/react-query';
import type { ProviderReadiness } from '@yantra/protocol';
import type { ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';
import { InvocationTwin, displayInvocation } from '../cockpit/cli-twin.js';

/** Whether `do` with these options could start now. */
export function useProviderReadiness(
  argv: readonly string[],
  cwd: string | null,
  enabled: boolean,
) {
  const rpc = useRpc();
  return useQuery({
    queryKey: ['provider-readiness', argv, cwd],
    enabled: enabled && cwd !== null,
    queryFn: () =>
      rpc.request<ProviderReadiness>('read.provider_readiness', { path: ['do'], argv, cwd }),
    placeholderData: (previous) => previous,
  });
}

/** Why Do cannot start, and the fix. */
export function DoBlocked({ readiness }: { readonly readiness: ProviderReadiness }): ReactNode {
  const fix = readiness.fix;
  const [first, ...rest] = fix?.path ?? [];
  return (
    <div
      role="note"
      className="flex flex-col gap-2 rounded-control border border-rule bg-sunken p-3"
    >
      <p className="text-signal-partial-ink">Do needs a model. {readiness.reason}</p>
      {fix === undefined || first === undefined ? null : (
        <InvocationTwin
          label={fix.label}
          invocation={displayInvocation([first, ...rest], fix.argv)}
        />
      )}
    </div>
  );
}
