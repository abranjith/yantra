import { createRoute, useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { surfaceById, type SurfaceDefinition, type SurfaceId } from '../surfaces/definitions.js';
import { GeneratedSurface } from '../surfaces/GeneratedSurface.js';

/** `?do=<command>`: open that page action's form (the command palette links here). */
export interface ActionSearch {
  readonly do?: string | undefined;
}

export interface InstallationSearch extends ActionSearch {
  readonly mode?: 'raw' | undefined;
}

export interface PreferencesSearch extends ActionSearch {
  readonly focus?: string | undefined;
}

export interface BrowserSearch extends ActionSearch {
  readonly intent?: 'install' | undefined;
}

const COMMAND = /^[a-z][a-z -]{0,63}$/u;

/** Keeps `do` only when it names a command path. */
export function actionSearch(search: Record<string, unknown>): ActionSearch {
  return typeof search.do === 'string' && COMMAND.test(search.do) ? { do: search.do } : {};
}

function GeneratedRouteView({ definition }: { readonly definition: SurfaceDefinition }): ReactNode {
  const search = useSearch({ strict: false });
  return <GeneratedSurface definition={definition} openAction={search.do} />;
}

function route(id: SurfaceId, path: string) {
  const definition = surfaceById(id);
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    validateSearch: actionSearch,
    component: () => <GeneratedRouteView definition={definition} />,
  });
}

function InstallationRouteView() {
  const { mode, do: action } = installationRoute.useSearch();
  return (
    <GeneratedSurface
      definition={surfaceById('installation')}
      initialMode={mode}
      openAction={action}
    />
  );
}

export const installationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/installation',
  validateSearch: (search: Record<string, unknown>): InstallationSearch => ({
    ...actionSearch(search),
    mode: search.mode === 'raw' ? 'raw' : undefined,
  }),
  component: InstallationRouteView,
});

function PreferencesRouteView() {
  const { focus, do: action } = preferencesRoute.useSearch();
  return (
    <GeneratedSurface definition={surfaceById('preferences')} focus={focus} openAction={action} />
  );
}

export const preferencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/preferences',
  validateSearch: (search: Record<string, unknown>): PreferencesSearch => ({
    ...actionSearch(search),
    focus: typeof search.focus === 'string' && search.focus.length > 0 ? search.focus : undefined,
  }),
  component: PreferencesRouteView,
});

export const modelsRoute = route('models', '/settings/models');

function BrowserRouteView() {
  const { intent, do: action } = browserRoute.useSearch();
  return (
    <GeneratedSurface definition={surfaceById('browser')} intent={intent} openAction={action} />
  );
}

export const browserRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/browser',
  validateSearch: (search: Record<string, unknown>): BrowserSearch => ({
    ...actionSearch(search),
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
