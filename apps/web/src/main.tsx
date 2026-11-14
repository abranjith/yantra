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
import { DeferredRpc, RpcProvider } from './host/app-rpc.js';
import { connectionStore } from './host/connection-store.js';
import { RpcDisconnectedError } from './host/rpc-client.js';

const container = document.getElementById('root');
if (container === null) throw new Error('Yantra app: #root is missing from index.html');

// Before any React Aria component mounts (see @yantra/ui csp.ts).
prepareStrictCsp(document);

const queryClient = new QueryClient({
  defaultOptions: {
    // Only a dropped socket is worth retrying; a host error is the answer.
    queries: {
      retry: (failures, error) => error instanceof RpcDisconnectedError && failures < 3,
    },
  },
});
const rpc = new DeferredRpc(connectionStore);

createRoot(container).render(
  <StrictMode>
    <RpcProvider rpc={rpc}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={makeRouter()} />
      </QueryClientProvider>
    </RpcProvider>
  </StrictMode>,
);

void bootstrap().then((connection) => {
  if (connection !== null) rpc.attach(connection.rpc);
});
