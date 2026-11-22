import { useQuery } from '@tanstack/react-query';
import type { HostEnvironmentInfo } from '@yantra/protocol';
import { useEffect, useState, type ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';

/** Formats the elapsed age between `capturedAtIso` and `nowMs` in plain English. */
export function formatRelativeAge(capturedAtIso: string, nowMs: number): string {
  const capturedMs = Date.parse(capturedAtIso);
  if (Number.isNaN(capturedMs)) return 'unknown';

  const diffSeconds = Math.max(0, Math.floor((nowMs - capturedMs) / 1000));
  if (diffSeconds < 60) {
    return diffSeconds === 1 ? '1 second ago' : `${String(diffSeconds)} seconds ago`;
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return diffMinutes === 1 ? '1 minute ago' : `${String(diffMinutes)} minutes ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return diffHours === 1 ? '1 hour ago' : `${String(diffHours)} hours ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? '1 day ago' : `${String(diffDays)} days ago`;
}

export interface HostEnvironmentPanelProps {
  /** Clock seam for deterministic relative-time rendering in tests. */
  readonly now?: () => number;
}

/**
 * "App host" block on Health (FEAT-071 TASK-009): shows when the host
 * captured its environment (D13), the restart instructions as text, the
 * Yantra version, and the host PID. Never displays environment variables.
 */
export function HostEnvironmentPanel({
  now = () => Date.now(),
}: HostEnvironmentPanelProps): ReactNode {
  const rpc = useRpc();
  const [tickMs, setTickMs] = useState<number>(() => now());

  useEffect(() => {
    setTickMs(now());
    const id = setInterval(() => {
      setTickMs(now());
    }, 30_000);
    return () => {
      clearInterval(id);
    };
  }, [now]);

  const query = useQuery({
    queryKey: ['health', 'host-status'],
    queryFn: () => rpc.request<HostEnvironmentInfo>('read.host_status', {}),
    retry: false,
  });

  const info = query.data;
  if (info === undefined) return null;

  const relativeAge = formatRelativeAge(info.env_captured_at, tickMs);

  return (
    <section
      aria-labelledby="health-host-env-heading"
      data-testid="health-host-environment"
      className="flex flex-col gap-3 rounded-frame border border-rule bg-surface p-4 text-caption"
    >
      <h2 id="health-host-env-heading" className="font-medium text-ink">
        App host
      </h2>
      <p className="text-micro text-ink" data-testid="host-env-captured">
        Environment captured {relativeAge} (at{' '}
        <span className="type-engine">{info.env_captured_at}</span>)
      </p>
      <p className="text-micro text-ink-2">
        Runs started from the app use the environment the app host started with. To pick up
        environment changes, close every Yantra window, wait for the host to exit, then run{' '}
        <span className="type-engine text-ink">yantra ui</span>.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-micro">
        <dt className="text-ink-2">Yantra version</dt>
        <dd className="type-engine text-ink" data-testid="host-yantra-version">
          {info.yantra_version}
        </dd>
        <dt className="text-ink-2">Host PID</dt>
        <dd className="type-engine text-ink" data-testid="host-pid">
          {String(info.host_pid)}
        </dd>
      </dl>
    </section>
  );
}
