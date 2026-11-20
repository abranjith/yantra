import { createRoute } from '@tanstack/react-router';

import { navRegistry } from '../app/nav-registry.js';
import { rootRoute } from '../app/root-route.js';
import { HealthSurface } from '../surfaces/health/health-route.js';

export const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/health',
  component: () => <HealthSurface />,
});

if (!navRegistry.entries().some((entry) => entry.path === '/health'))
  navRegistry.register({ path: '/health', label: 'Health' });
