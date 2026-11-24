import { createRoute } from '@tanstack/react-router';

import { rootRoute } from '../app/root-route.js';
import { CredentialsSurface } from '../surfaces/settings/credentials/credentials-route.js';

export interface CredentialsSearch {
  readonly key?: string | undefined;
}

function CredentialsRouteView(): React.ReactNode {
  const { key } = credentialsRoute.useSearch();
  return <CredentialsSurface initialKey={key} />;
}

export const credentialsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/credentials',
  validateSearch: (search: Record<string, unknown>): CredentialsSearch => ({
    key: typeof search.key === 'string' && search.key.length > 0 ? search.key : undefined,
  }),
  component: CredentialsRouteView,
});
