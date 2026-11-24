import { createRoute } from '@tanstack/react-router';

import { rootRoute } from '../app/root-route.js';
import { surfaceById, type SurfaceId } from '../surfaces/definitions.js';
import { GeneratedSurface } from '../surfaces/GeneratedSurface.js';

export interface InstallationSearch {
  readonly mode?: 'raw' | undefined;
}

export interface PreferencesSearch {
  readonly focus?: string | undefined;
}

export interface BrowserSearch {
  readonly intent?: 'install' | undefined;
}

function route(id: SurfaceId, path: string) {
  const definition = surfaceById(id);
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <GeneratedSurface definition={definition} />,
  });
}

function InstallationRouteView() {
  const { mode } = installationRoute.useSearch();
  return <GeneratedSurface definition={surfaceById('installation')} initialMode={mode} />;
}

export const installationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/installation',
  validateSearch: (search: Record<string, unknown>): InstallationSearch => ({
    mode: search.mode === 'raw' ? 'raw' : undefined,
  }),
  component: InstallationRouteView,
});

function PreferencesRouteView() {
  const { focus } = preferencesRoute.useSearch();
  return <GeneratedSurface definition={surfaceById('preferences')} focus={focus} />;
}

export const preferencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/preferences',
  validateSearch: (search: Record<string, unknown>): PreferencesSearch => ({
    focus: typeof search.focus === 'string' && search.focus.length > 0 ? search.focus : undefined,
  }),
  component: PreferencesRouteView,
});

export const modelsRoute = route('models', '/settings/models');

function BrowserRouteView() {
  const { intent } = browserRoute.useSearch();
  return <GeneratedSurface definition={surfaceById('browser')} intent={intent} />;
}

export const browserRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/browser',
  validateSearch: (search: Record<string, unknown>): BrowserSearch => ({
    intent: search.intent === 'install' ? 'install' : undefined,
  }),
  component: BrowserRouteView,
});
export const sitesRoute = route('sites', '/settings/sites');
export const dataRoute = route('data', '/settings/data');
export const workflowsRoute = route('workflows', '/workflows');
export const templatesRoute = route('templates', '/templates');
export const schedulesRoute = route('schedules', '/schedules');
export const usageRoute = route('usage', '/usage');
export const daemonRoute = route('daemon', '/daemon');
