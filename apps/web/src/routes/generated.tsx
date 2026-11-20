import { createRoute } from '@tanstack/react-router';

import { navRegistry } from '../app/nav-registry.js';
import { rootRoute } from '../app/root-route.js';
import { surfaceById, type SurfaceId } from '../surfaces/definitions.js';
import { GeneratedSurface } from '../surfaces/GeneratedSurface.js';

function route(id: SurfaceId, path: string) {
  const definition = surfaceById(id);
  if (!navRegistry.entries().some((entry) => entry.path === path))
    navRegistry.register({ path, label: definition.title });
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <GeneratedSurface definition={definition} />,
  });
}

export const installationRoute = route('installation', '/settings/installation');
export const preferencesRoute = route('preferences', '/settings/preferences');
export const modelsRoute = route('models', '/settings/models');
export const browserRoute = route('browser', '/settings/browser');
export const sitesRoute = route('sites', '/settings/sites');
export const dataRoute = route('data', '/settings/data');
export const workflowsRoute = route('workflows', '/workflows');
export const templatesRoute = route('templates', '/templates');
export const schedulesRoute = route('schedules', '/schedules');
export const usageRoute = route('usage', '/usage');
export const daemonRoute = route('daemon', '/daemon');
export const healthRoute = route('health', '/health');
