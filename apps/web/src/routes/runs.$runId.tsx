/**
 * Run result (`/runs/<id>`, FEAT-066).
 */

import { createRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';

/** The run-result page for one run. */
export function RunResultView({ runId }: { readonly runId: string }): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-ink">Run result</h1>
      <p className="type-engine text-ink-2">{runId}</p>
    </div>
  );
}

function RunResultPage(): ReactNode {
  const { runId } = runRoute.useParams();
  return <RunResultView runId={runId} />;
}

/** `/runs/$runId`. */
export const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId',
  component: RunResultPage,
});
