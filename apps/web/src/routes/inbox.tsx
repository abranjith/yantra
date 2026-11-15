import { createRoute } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';

import { navRegistry } from '../app/nav-registry.js';
import { rootRoute } from '../app/root-route.js';
import { ConsentCard } from '../features/interventions/ConsentCard.js';
import {
  InterventionsStore,
  useInterventionsStore,
} from '../features/interventions/interventions-store.js';
import { useRpc } from '../host/app-rpc.js';

function InboxPage(): ReactNode {
  const rpc = useRpc();
  const [store] = useState(() => new InterventionsStore(rpc));
  const state = useInterventionsStore(store);
  useEffect(() => store.start(), [store]);

  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-ink-3">Inbox</p>
        <h1 className="text-3xl font-semibold text-ink">Needs your attention</h1>
        <p className="mt-2 text-sm text-ink-2" aria-live="polite">
          {state.count} item{state.count === 1 ? '' : 's'}
        </p>
      </header>
      {state.error !== null ? <p role="alert">{state.error}</p> : null}
      {state.loading && state.items.length === 0 ? <p>Loading…</p> : null}
      {!state.loading && state.items.length === 0 ? <p>No items need your attention.</p> : null}
      <div className="flex flex-col gap-4">
        {state.items.map((item) =>
          item.kind === 'consent_live' || item.kind === 'consent_parked' ? (
            <ConsentCard key={item.item_id} item={item} store={store} />
          ) : (
            <article key={item.item_id} className="rounded-card border border-rule bg-surface p-5">
              <h2 className="font-semibold text-ink">{item.title}</h2>
              {item.intervention?.handoff ? (
                <p className="mt-2 text-sm text-ink-2">{item.intervention.handoff.blocker}</p>
              ) : null}
              {item.intervention?.missing ? (
                <ul className="mt-2 list-disc pl-5 text-sm text-ink-2">
                  {item.intervention.missing.map((missing) => (
                    <li key={missing.label}>
                      {missing.label}: {missing.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.dismissible ? (
                <button
                  type="button"
                  className="mt-3 rounded-chip border border-rule px-3 py-1 text-sm"
                  onClick={() => void store.dismiss(item.item_id)}
                >
                  Dismiss
                </button>
              ) : null}
            </article>
          ),
        )}
      </div>
    </section>
  );
}

export const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxPage,
});

if (!navRegistry.entries().some((entry) => entry.path === '/inbox'))
  navRegistry.register({ path: '/inbox', label: 'Inbox' });
