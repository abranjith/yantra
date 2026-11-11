import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { AppShell } from './shell/AppShell.js';

/** Home: FEAT-065's only route. Later features add theirs beside it. */
export function HomePage(): ReactNode {
  return (
    <section className="flex max-w-2xl flex-col gap-2">
      <h1 className="text-xl font-semibold text-ink">Yantra</h1>
      <p className="text-ink-2">Connected to the Yantra on this computer.</p>
    </section>
  );
}

const rootRoute = createRootRoute({ component: () => <AppShell /> });

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });

/** The route tree; the shell renders it. */
export const routeTree = rootRoute.addChildren([homeRoute]);

/** Builds the router, with an injected history in tests. */
export function makeRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history === undefined ? {} : { history }) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
