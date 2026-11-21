/**
 * The cockpit before a run exists (`/mission/invocations/<id>`, FEAT-067
 * TASK-005): an app invocation that is queued, starting, needs review, or
 * whose start is unknown.
 *
 * It follows the invocation through `read.invocation` and its change
 * notices, and replaces itself with the run's cockpit as soon as a run ID
 * exists, so Back never returns to a page that has moved on. A reload lands
 * here again and follows the same invocation.
 */

import { createRoute, Link as RouterLink, useNavigate } from '@tanstack/react-router';
import type { InvocationSummary } from '@yantra/protocol';
import { useEffect, useMemo, type ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { CockpitAnnouncer, announceView } from '../features/cockpit/CockpitAnnouncer.js';
import { CockpitStatus } from '../features/cockpit/CockpitStatus.js';
import { initialCockpitState, modeOf } from '../features/live/cockpit-state.js';
import { deriveDisplayedState } from '../features/live/displayed-state.js';
import { useInvocation } from '../features/live/use-invocation.js';
import { useConnection } from '../host/connection-store.js';
import { RpcCallError } from '../host/rpc-client.js';

/** The pre-run cockpit for one invocation. */
export function PreRunCockpit({
  invocation,
}: {
  readonly invocation: InvocationSummary;
}): ReactNode {
  const connection = useConnection();
  const displayed = deriveDisplayedState({
    invocation,
    connection,
    channel: { state: 'connecting' },
    cockpit: null,
    stopping: false,
  });
  const empty = useMemo(
    () => initialCockpitState(invocation.invocation_id),
    [invocation.invocation_id],
  );
  const view = useMemo(() => announceView(empty, displayed.kind), [empty, displayed.kind]);
  return (
    <div data-part="cockpit" className="flex flex-col gap-4 rounded-frame bg-sunken p-4">
      <div className="glass rounded-frame p-3">
        <p className="flex items-baseline gap-1 rounded-control bg-surface p-2">
          <span className="type-label text-ink-2">Mode</span>
          <span className="type-engine text-ink" data-part="mode">
            {invocation.path.join(' ')}
          </span>
        </p>
      </div>
      <CockpitStatus displayed={displayed} cockpit={null} />
      <CockpitAnnouncer view={view} />
    </div>
  );
}

/** The invocation page for `invocationId`. */
export function MissionInvocationPage({
  invocationId,
}: {
  readonly invocationId: string;
}): ReactNode {
  const invocation = useInvocation(invocationId);
  const navigate = useNavigate();
  const data = invocation.data;
  const runId = data?.run_id ?? null;

  useEffect(() => {
    if (data === undefined || runId === null) return;
    const mode = modeOf(data.path);
    void navigate({
      to: '/mission/runs/$runId',
      params: { runId },
      search: { invocation: invocationId, ...(mode === 'other' ? {} : { mode }) },
      replace: true,
    });
  }, [data, runId, invocationId, navigate]);

  if (invocation.isError) {
    const notFound =
      invocation.error instanceof RpcCallError && invocation.error.reason === 'not_found';
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-title font-semibold text-ink">
          {notFound ? 'Nothing to follow' : 'Couldn’t load this run'}
        </h1>
        <p className="text-ink-2">
          {notFound ? `There is no queued item ${invocationId}.` : invocation.error.message}
        </p>
        <RouterLink to="/mission" className="text-accent-ink underline underline-offset-2">
          Back to Mission
        </RouterLink>
      </div>
    );
  }
  if (data === undefined) {
    return (
      <p role="status" className="text-ink-2">
        Loading…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">Run {invocationId}</h1>
      <PreRunCockpit invocation={data} />
    </div>
  );
}

function MissionInvocationRoute(): ReactNode {
  const { invocationId } = missionInvocationRoute.useParams();
  return <MissionInvocationPage key={invocationId} invocationId={invocationId} />;
}

/** `/mission/invocations/$invocationId`. */
export const missionInvocationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mission/invocations/$invocationId',
  component: MissionInvocationRoute,
});
