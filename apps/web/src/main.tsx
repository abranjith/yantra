// The launch code leaves the URL before any other module runs.
import './boot/take-launch-code.js';
import './styles.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { prepareStrictCsp } from '@yantra/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { bootstrap } from './app/bootstrap.js';
import { makeRouter } from './app/router.js';

const container = document.getElementById('root');
if (container === null) throw new Error('Yantra app: #root is missing from index.html');

// Before any React Aria component mounts (see @yantra/ui csp.ts).
prepareStrictCsp(document);

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={makeRouter()} />
    </QueryClientProvider>
  </StrictMode>,
);

void bootstrap();
