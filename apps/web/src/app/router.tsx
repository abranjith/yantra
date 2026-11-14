import { createRouter, type RouterHistory } from '@tanstack/react-router';

import { ledgerRoute } from '../routes/ledger.js';
import { missionInvocationRoute } from '../routes/mission.invocations.$invocationId.js';
import { homeRoute, missionRoute } from '../routes/mission.js';
import { missionRunRoute } from '../routes/mission.runs.$runId.js';
import { artifactRoute } from '../routes/runs.$runId.artifacts.$.js';
import { auditRoute } from '../routes/runs.$runId.audit.js';
import { runRoute } from '../routes/runs.$runId.js';

import { rootRoute } from './root-route.js';

/** The route tree; the shell renders it. */
export const routeTree = rootRoute.addChildren([
  homeRoute,
  missionRoute,
  ledgerRoute,
  runRoute,
  auditRoute,
  artifactRoute,
  missionRunRoute,
  missionInvocationRoute,
]);

/** Builds the router, with an injected history in tests. */
export function makeRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history === undefined ? {} : { history }) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
