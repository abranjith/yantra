import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from '@tanstack/react-router';
import type { PossibleOrphansResult } from '@yantra/protocol';
import { Button, linkStyles } from '@yantra/ui';
import type { ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';

/**
 * "Possible orphans" block on Health (FEAT-071 TASK-009): read-only list of
 * retained FEAT-064 ownership records whose process identity is
 * `unknown`. Hidden when empty; never offers a kill or terminate control.
 */
export function PossibleOrphansPanel(): ReactNode {
  const rpc = useRpc();

  const query = useQuery({
    queryKey: ['health', 'possible-orphans'],
    queryFn: () => rpc.request<PossibleOrphansResult>('read.possible_orphans', {}),
    retry: false,
  });

  const orphans = query.data?.orphans;
  if (orphans === undefined || orphans.length === 0) return null;

  return (
    <section
      aria-labelledby="health-possible-orphans-heading"
      data-testid="health-possible-orphans"
      className="flex flex-col gap-3 rounded-frame border border-rule bg-surface p-4 text-caption"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="health-possible-orphans-heading" className="font-medium text-ink">
          Possible orphans
        </h2>
        <Button
          variant="secondary"
          isDisabled={query.isFetching}
          onPress={() => {
            void query.refetch();
          }}
        >
          {query.isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      <p className="text-micro text-ink-2">
        Yantra could not confirm this process belongs to the run, so it was not stopped.
      </p>
      <ul className="flex flex-col gap-2">
        {orphans.map((orphan) => (
          <li
            key={`${orphan.run_id}:${String(orphan.pid)}:${orphan.recorded_at}`}
            data-testid={`possible-orphan-${orphan.run_id}-${String(orphan.pid)}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-rule bg-sunken p-3 text-micro"
          >
            <div className="flex flex-wrap items-center gap-3">
              <RouterLink
                to="/runs/$runId"
                params={{ runId: orphan.run_id }}
                className={linkStyles()}
              >
                {orphan.run_id}
              </RouterLink>
              <span className="text-ink-2">
                PID <span className="type-engine text-ink">{String(orphan.pid)}</span>
              </span>
              <span className="type-engine text-ink">{orphan.executable}</span>
            </div>
            <span className="type-engine text-ink-2">{orphan.recorded_at}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
