import { createRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { OnboardingSurface } from '../surfaces/onboarding/onboarding-route.js';

export interface OnboardingSearch {
  readonly reset?: boolean;
}

function OnboardingRouteView(): ReactNode {
  const { reset } = onboardingRoute.useSearch();
  return <OnboardingSurface initialReset={reset === true} />;
}

export const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  validateSearch: (search: Record<string, unknown>): OnboardingSearch => ({
    ...(search.reset === 1 || search.reset === '1' || search.reset === true ? { reset: true } : {}),
  }),
  component: OnboardingRouteView,
});
