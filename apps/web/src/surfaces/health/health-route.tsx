import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DoctorResult } from '@yantra/protocol';
import { Button, HealthCheck } from '@yantra/ui';
import type { ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Health (`/health`, FEAT-071 TASK-006): renders every `yantra doctor` check
 * from an in-process `read.doctor` call, plus browser and search provenance.
 */
export function HealthSurface(): ReactNode {
  const rpc = useRpc();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['health', 'doctor'],
    queryFn: () => rpc.request<DoctorResult>('read.doctor', { refresh: false }),
  });

  const rerun = useMutation({
    mutationFn: () => rpc.request<DoctorResult>('read.doctor', { refresh: true }),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['health', 'doctor'], fresh);
    },
  });

  const data = query.data;
  const error = query.error ?? rerun.error;

  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold text-ink">Health</h1>
          <p className="mt-1 text-sm text-ink-2">
            Offline environment diagnostics from <span className="type-engine">yantra doctor</span>.
          </p>
        </div>
        <Button
          variant="secondary"
          isDisabled={query.isLoading || rerun.isPending}
          onPress={() => {
            rerun.mutate();
          }}
        >
          {rerun.isPending ? 'Re-running…' : 'Re-run checks'}
        </Button>
      </header>

      {error !== null && error !== undefined ? (
        <p
          role="alert"
          className="rounded-card border border-rule bg-surface p-4 text-sm text-signal-failed-ink"
        >
          {error instanceof Error ? error.message : 'Failed to load health diagnostics.'}
        </p>
      ) : null}

      {query.isLoading ? <p className="text-sm text-ink-2">Running diagnostics…</p> : null}

      {data !== undefined ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-rule bg-surface p-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-ink-2">Overall:</span>
              <span className="font-semibold text-ink" data-testid="health-overall">
                {data.overall}
              </span>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-ink-2">
              <span>
                Platform: <span className="type-engine text-ink">{data.platform}</span>
              </span>
              <span>
                Node: <span className="type-engine text-ink">{data.nodeVersion}</span>
              </span>
              <span>
                Protocol: <span className="type-engine text-ink">{data.version}</span>
              </span>
            </div>
          </div>

          {data.browser !== undefined ? (
            <section
              aria-labelledby="health-browser-heading"
              className="flex flex-col gap-2 rounded-card border border-rule bg-surface p-4 text-sm"
            >
              <h2 id="health-browser-heading" className="font-medium text-ink">
                Browser provenance
              </h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                <dt className="text-ink-2">Selection</dt>
                <dd className="type-engine text-ink">
                  {data.browser.source} ({data.browser.origin}
                  {data.browser.ownership !== undefined ? `, ${data.browser.ownership}` : ''})
                </dd>
                {data.browser.executablePath !== undefined ? (
                  <>
                    <dt className="text-ink-2">Executable</dt>
                    <dd className="type-engine break-all text-ink">
                      {data.browser.executablePath}
                    </dd>
                  </>
                ) : null}
                {data.browser.browserVersion !== undefined ? (
                  <>
                    <dt className="text-ink-2">Browser version</dt>
                    <dd className="type-engine text-ink">{data.browser.browserVersion}</dd>
                  </>
                ) : null}
                <dt className="text-ink-2">Compatibility</dt>
                <dd className="type-engine text-ink">{data.browser.compatibility}</dd>
                <dt className="text-ink-2">Managed build</dt>
                <dd className="type-engine text-ink">
                  {data.browser.managedBuild ?? 'absent'} ({data.browser.managedRoot})
                </dd>
                <dt className="text-ink-2">Superseded builds</dt>
                <dd className="type-engine text-ink">
                  {String(data.browser.orphanCount)} ({formatBytes(data.browser.reclaimableBytes)}{' '}
                  reclaimable)
                </dd>
              </dl>
              {data.browser.remediation !== undefined ? (
                <p className="mt-1 text-xs text-ink-2">{data.browser.remediation}</p>
              ) : null}
            </section>
          ) : null}

          {data.search !== undefined ? (
            <section
              aria-labelledby="health-search-heading"
              className="flex flex-col gap-2 rounded-card border border-rule bg-surface p-4 text-sm"
            >
              <h2 id="health-search-heading" className="font-medium text-ink">
                Search provenance
              </h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                <dt className="text-ink-2">Provider</dt>
                <dd className="type-engine text-ink">{data.search.provider}</dd>
                <dt className="text-ink-2">Kind</dt>
                <dd className="type-engine text-ink">{data.search.kind}</dd>
                <dt className="text-ink-2">Selected via</dt>
                <dd className="type-engine text-ink">{data.search.via}</dd>
              </dl>
            </section>
          ) : null}

          <div className="flex flex-col gap-3" data-testid="health-checks">
            {data.checks.map((check) => (
              <HealthCheck
                key={check.id}
                id={check.id}
                title={check.title}
                status={check.status}
                summary={check.summary}
                {...(check.details === undefined ? {} : { details: check.details })}
                {...(check.remediation === undefined ? {} : { remediation: check.remediation })}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
