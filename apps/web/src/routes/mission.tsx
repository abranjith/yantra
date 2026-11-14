/**
 * Mission (`/mission`, FEAT-067): the app's start page and the one place to
 * start work. The composer submits once and lands in the cockpit (TASK-011).
 */

import { createRoute, redirect } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { Composer } from '../features/composer/Composer.js';

/** The Mission page. */
export function MissionPage(): ReactNode {
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Composer />
    </div>
  );
}

/** `/mission`. */
export const missionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mission',
  component: MissionPage,
});

/** `/`: Mission is the start page. */
export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's redirect contract.
    throw redirect({ to: '/mission', replace: true });
  },
});
