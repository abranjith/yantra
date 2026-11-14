import { createRootRoute } from '@tanstack/react-router';

import { AppShell } from './shell/AppShell.js';

/** The root route: the app shell renders every page. Route modules hang off it. */
export const rootRoute = createRootRoute({ component: () => <AppShell /> });
