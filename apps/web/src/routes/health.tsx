import { createRoute } from '@tanstack/react-router';

import { rootRoute } from '../app/root-route.js';
import { HealthSurface } from '../surfaces/health/health-route.js';

export const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/health',
  component: () => <HealthSurface />,
});
