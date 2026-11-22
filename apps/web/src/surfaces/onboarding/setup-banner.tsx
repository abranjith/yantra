import { Link as RouterLink } from '@tanstack/react-router';
import { linkStyles } from '@yantra/ui';
import type { ReactNode } from 'react';

/**
 * Non-modal banner shown on Mission when `config.yaml` is absent and the user
 * chose "Not now". Dismissal is never persisted to `profile.yaml` or storage.
 */
export function SetupBanner(): ReactNode {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-frame border border-rule bg-surface px-4 py-3 text-caption"
    >
      <span className="text-ink">Yantra isn&apos;t set up yet</span>
      <RouterLink to="/onboarding" className={linkStyles()}>
        Set up
      </RouterLink>
    </div>
  );
}
