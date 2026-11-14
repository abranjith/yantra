/**
 * The cockpit route (`/mission/runs/<id>`, FEAT-067): one run, live. A
 * reload resumes the stream from the run's file with no gaps (TASK-001).
 */

import { createRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { useRunResult } from '../data/runs.js';
import { Cockpit } from '../features/cockpit/Cockpit.js';
import { modeOf, type CockpitMode } from '../features/live/cockpit-state.js';
import { useRunStream } from '../features/live/use-run-stream.js';

/** Search params: the command word, when the invocation route already knows it. */
export interface MissionRunSearch {
  readonly mode?: CockpitMode;
}

/** The cockpit page for `runId`. */
export function MissionRunPage({
  runId,
  mode,
}: {
  readonly runId: string;
  readonly mode?: CockpitMode;
}): ReactNode {
  const stream = useRunStream(runId, mode === undefined ? {} : { mode });
  // Without a mode from the invocation, the run result names the command.
  const result = useRunResult(runId);
  const resultMode = result.data === undefined ? undefined : modeOf([result.data.mode]);
  const shown = mode ?? (resultMode === 'other' ? undefined : resultMode);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">Run {runId}</h1>
      <Cockpit stream={stream} {...(shown === undefined ? {} : { mode: shown })} />
    </div>
  );
}

function MissionRunRoute(): ReactNode {
  const { runId } = missionRunRoute.useParams();
  const { mode } = missionRunRoute.useSearch();
  return <MissionRunPage key={runId} runId={runId} {...(mode === undefined ? {} : { mode })} />;
}

/** `/mission/runs/$runId`. */
export const missionRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mission/runs/$runId',
  validateSearch: (search: Record<string, unknown>): MissionRunSearch => {
    const mode = modeOf([typeof search.mode === 'string' ? search.mode : '']);
    return mode === 'other' ? {} : { mode };
  },
  component: MissionRunRoute,
});
