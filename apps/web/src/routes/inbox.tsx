import { createRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { PageHeader } from '../app/shell/PageHeader.js';
import { ConsentCard } from '../features/interventions/ConsentCard.js';
import { useInterventions } from '../features/interventions/interventions-context.js';
import { useInterventionsStore } from '../features/interventions/interventions-store.js';

function InboxPage(): ReactNode {
  // The window's store (REV-005): the shell started it, so the badge, the
  // Bindu and this page show one count.
  const store = useInterventions();
  const state = useInterventionsStore(store);

  return (
    <section className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        eyebrow="Inbox"
        title="Needs your attention"
        aside={
          <p className="type-engine text-caption text-ink-3" aria-live="polite">
            {state.count} item{state.count === 1 ? '' : 's'}
          </p>
        }
      />
      {state.error !== null ? <p role="alert">{state.error}</p> : null}
      {state.loading && state.items.length === 0 ? <p>Loading…</p> : null}
      {!state.loading && state.items.length === 0 ? <p>No items need your attention.</p> : null}
      <div className="flex flex-col gap-4">
        {state.items.map((item) =>
          item.kind === 'consent_live' || item.kind === 'consent_parked' ? (
            <ConsentCard key={item.item_id} item={item} store={store} />
          ) : (
            <article key={item.item_id} className="rounded-frame border border-rule bg-surface p-5">
              <h2 className="font-semibold text-ink">{item.title}</h2>
              {item.intervention?.handoff ? (
                <p className="mt-2 text-caption text-ink-2">{item.intervention.handoff.blocker}</p>
              ) : null}
              {item.intervention?.missing ? (
                <ul className="mt-2 list-disc pl-5 text-caption text-ink-2">
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
                  className="mt-3 rounded-chip border border-rule px-3 py-1 text-caption"
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
