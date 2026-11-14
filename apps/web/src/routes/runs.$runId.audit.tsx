/**
 * Audit (`/runs/<id>/audit`, FEAT-066 TASK-009): the Run result page opened
 * on its Audit tab, the app's `yantra audit <id>`.
 */

import { createRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';

import { RunPage } from './runs.$runId.js';

function AuditPage(): ReactNode {
  const { runId } = auditRoute.useParams();
  return <RunPage runId={runId} tab="audit" />;
}

/** `/runs/$runId/audit`. */
export const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId/audit',
  component: AuditPage,
});
