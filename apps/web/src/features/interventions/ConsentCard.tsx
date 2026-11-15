import type { DecisionResponse, InboxItem } from '@yantra/protocol';
import { GuardedSwitch } from '@yantra/ui';
import { useState, type ReactNode } from 'react';

import { decisionMessage } from './decision-messages.js';
import type { InterventionsStore } from './interventions-store.js';

export function ConsentCard({
  item,
  store,
}: {
  readonly item: InboxItem;
  readonly store: InterventionsStore;
}): ReactNode {
  const [response, setResponse] = useState<DecisionResponse | null>(null);
  const [pending, setPending] = useState(false);
  const request = item.intervention?.request;
  if (request === null || request === undefined) return <p>Unreadable consent request.</p>;

  const decide = async (decision: 'granted' | 'denied'): Promise<void> => {
    setPending(true);
    try {
      setResponse(await store.answer(item, decision));
    } finally {
      setPending(false);
    }
  };

  return (
    <article className="flex max-w-2xl flex-col gap-4 rounded-card border border-rule bg-surface p-5">
      <div>
        <p className="text-xs uppercase tracking-wide text-ink-3">
          {request.action_kind} on {request.host}
        </p>
        <h2 className="mt-1 text-lg font-semibold text-ink">{request.description}</h2>
        <p className="mt-2 text-sm text-ink-2">Consequence: {request.consequence}</p>
      </div>
      {response === null ? (
        <GuardedSwitch
          actionLabel={`${request.action_kind} on ${request.host}`}
          consequence={request.description}
          deadlineAt={item.intervention?.attended_deadline_at ?? null}
          onDecide={decide}
          pendingResponse={pending}
        />
      ) : (
        <p role="status" className="text-sm text-ink-2">
          {decisionMessage(response)}
        </p>
      )}
    </article>
  );
}
