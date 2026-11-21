import { useQuery } from '@tanstack/react-query';
import type { CredentialListResult, CredentialRow } from '@yantra/protocol';
import { Button, ProtectedValue } from '@yantra/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useRpc } from '../../../host/app-rpc.js';

import { RemoveCredentialDialog } from './remove-credential-dialog.js';
import { SetCredentialDialog } from './set-credential-dialog.js';

export interface CredentialsSurfaceProps {
  /** Optional key prefilled from a route search param (`?key=tavily.api_key`). */
  readonly initialKey?: string | undefined;
}

/**
 * Settings → Credentials (`/settings/credentials`, FEAT-071 TASK-002).
 * Lists credential names, sources, and references without ever reading back
 * stored values.
 */
export function CredentialsSurface({ initialKey }: CredentialsSurfaceProps): ReactNode {
  const rpc = useRpc();
  const [setDialogOpen, setSetDialogOpen] = useState(initialKey !== undefined);
  const [setDialogKey, setSetDialogKey] = useState<string | undefined>(initialKey);
  const [removeTarget, setRemoveTarget] = useState<CredentialRow | null>(null);

  useEffect(() => {
    if (initialKey !== undefined) {
      setSetDialogKey(initialKey);
      setSetDialogOpen(true);
    }
  }, [initialKey]);

  const query = useQuery({
    queryKey: ['credentials', 'list'],
    queryFn: () => rpc.request<CredentialListResult>('secret.list', {}),
  });

  const data = query.data;
  const available = data?.available ?? false;
  const remedy = data?.remedy ?? null;

  function openSet(key?: string): void {
    setSetDialogKey(key);
    setSetDialogOpen(true);
  }

  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold text-ink">Credentials</h1>
          <p className="mt-1 text-caption text-ink-2">
            Secrets are write-only and stored in your OS keychain. Stored values can never be viewed
            in the app.
          </p>
        </div>
        <Button
          variant="primary"
          isDisabled={!available}
          onPress={() => {
            openSet(undefined);
          }}
        >
          Set credential
        </Button>
      </header>

      {query.isError ? (
        <p
          role="alert"
          className="rounded-frame border border-rule bg-surface p-4 text-caption text-signal-failed-ink"
        >
          {query.error instanceof Error ? query.error.message : 'Failed to load credentials.'}
        </p>
      ) : null}

      {data !== undefined && !available ? (
        <div
          role="alert"
          className="rounded-frame border border-rule bg-surface p-4 text-caption text-ink"
        >
          <p className="font-medium">OS keychain unavailable</p>
          <p className="mt-1 text-ink-2">
            {remedy ?? 'Enable your OS keychain to set or remove credentials.'}
          </p>
        </div>
      ) : null}

      {query.isLoading ? <p className="text-caption text-ink-2">Loading credentials…</p> : null}

      {data?.rows.length === 0 ? (
        <p className="text-caption text-ink-2">No credentials configured or stored yet.</p>
      ) : null}

      {data !== undefined && data.rows.length > 0 ? (
        <div className="overflow-x-auto rounded-frame border border-rule bg-surface">
          <table className="w-full border-collapse text-left text-caption">
            <thead>
              <tr className="border-b border-rule text-ink-2">
                <th scope="col" className="px-4 py-3 font-medium">
                  Key
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Source
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Used by
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.key} className="border-b border-rule last:border-b-0">
                  <th scope="row" className="type-engine px-4 py-3 font-normal text-ink">
                    {row.key}
                  </th>
                  <td className="px-4 py-3">
                    <span className="type-engine rounded-chip bg-sunken px-2 py-0.5 text-micro text-ink">
                      {row.source}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {row.referenced_by.length === 0 ? (
                      <span className="text-ink-3">Not referenced</span>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {row.referenced_by.map((item) => (
                          <li
                            key={`${item.kind}:${item.id}`}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <span className="text-ink">
                              {item.kind} {item.id}
                            </span>
                            <span className="type-engine text-micro text-ink-2">
                              {item.ref.kind === 'secret'
                                ? `\${secret:${item.ref.key}}`
                                : `\${env:${item.ref.name}}`}
                            </span>
                            <ProtectedValue reason="stored_secret" />
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={!available}
                        onPress={() => {
                          openSet(row.key);
                        }}
                      >
                        {row.source === 'keychain' ? 'Replace' : 'Set'}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={!available || row.source !== 'keychain'}
                        onPress={() => {
                          setRemoveTarget(row);
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <SetCredentialDialog
        isOpen={setDialogOpen}
        initialKey={setDialogKey}
        onClose={() => {
          setSetDialogOpen(false);
        }}
      />
      <RemoveCredentialDialog
        row={removeTarget}
        onClose={() => {
          setRemoveTarget(null);
        }}
      />
    </section>
  );
}
