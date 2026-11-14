/**
 * The cockpit route (`/mission/runs/<id>`, FEAT-067): one run, live. A
 * reload resumes the stream from the run's file with no gaps (TASK-001).
 */

import { createRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { Cockpit } from '../features/cockpit/Cockpit.js';
import { useRunStream } from '../features/live/use-run-stream.js';

/** The cockpit page for `runId`. */
export function MissionRunPage({ runId }: { readonly runId: string }): ReactNode {
  const stream = useRunStream(runId);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">Run {runId}</h1>
      <Cockpit stream={stream} />
    </div>
  );
}

function MissionRunRoute(): ReactNode {
  const { runId } = missionRunRoute.useParams();
  return <MissionRunPage key={runId} runId={runId} />;
}

/** `/mission/runs/$runId`. */
export const missionRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mission/runs/$runId',
  component: MissionRunRoute,
});
