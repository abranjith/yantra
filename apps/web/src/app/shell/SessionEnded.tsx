import type { ReactNode } from 'react';

/**
 * Shown when this window's session is gone (expired, revoked, or a reload
 * with no resume code). Only `yantra ui` opens a new one (plan §7).
 */
export function SessionEnded({ detail }: { readonly detail?: string }): ReactNode {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-3 px-6 py-16 text-ink">
      <h1 className="text-xl font-semibold">Session ended</h1>
      <p className="text-ink-2">
        Run <code className="font-mono text-ink">yantra ui</code> to reopen the Yantra app.
      </p>
      {detail === undefined ? null : <p className="text-sm text-ink-3">{detail}</p>}
    </main>
  );
}
