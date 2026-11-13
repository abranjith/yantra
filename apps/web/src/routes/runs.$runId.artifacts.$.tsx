/**
 * The bounded artifact viewer (`/runs/<id>/artifacts/<path>`, FEAT-066).
 */

import { createRoute, Link as RouterLink } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';

/** One artifact in its viewer. */
export function ArtifactPage({
  runId,
  path,
}: {
  readonly runId: string;
  readonly path: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <RouterLink
        to="/runs/$runId"
        params={{ runId }}
        className="text-accent-ink underline underline-offset-2"
      >
        Back to the run
      </RouterLink>
      <h1 className="type-engine text-xl text-ink">{path}</h1>
    </div>
  );
}

function ArtifactRoutePage(): ReactNode {
  const { runId, _splat } = artifactRoute.useParams();
  return <ArtifactPage runId={runId} path={_splat ?? ''} />;
}

/** `/runs/$runId/artifacts/$`. */
export const artifactRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId/artifacts/$',
  component: ArtifactRoutePage,
});
