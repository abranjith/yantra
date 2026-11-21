import { Link as RouterLink } from '@tanstack/react-router';
import type { OnboardingResult } from '@yantra/protocol';
import { Button, linkStyles } from '@yantra/ui';
import type { ReactNode } from 'react';

import { useToasts } from '../../app/shell/toasts.js';

const MODELS_PATH = '/settings/models' as '/mission';

export interface OnboardingResultProps {
  readonly result: OnboardingResult;
}

/**
 * Displays the completed onboarding summary without echoing any secret values.
 */
export function OnboardingResultView({ result }: OnboardingResultProps): ReactNode {
  const toasts = useToasts();
  const locationLine = result.location_shared
    ? 'Location sharing: on. Change it with `yantra prefs set context.location false`.'
    : 'Location sharing: off. Change it with `yantra prefs set context.location true`.';

  async function copyManualCommand(command: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(command);
      toasts?.add({ title: 'Copied command.', tone: 'fulfilled' });
    } catch {
      toasts?.add({ title: 'Could not copy command to clipboard.', tone: 'failed' });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-frame border border-rule bg-surface p-5 text-caption">
        <p className="font-medium text-ink">Configuration written</p>
        <dl className="mt-3 grid gap-2 sm:grid-cols-[10rem_1fr]">
          <dt className="text-ink-2">Config file</dt>
          <dd className="type-engine break-all text-ink">{result.config_path}</dd>
          <dt className="text-ink-2">Profile file</dt>
          <dd className="type-engine break-all text-ink">
            {result.profile_path}
            {result.profile_written ? '' : ' (existing profile kept)'}
          </dd>
          <dt className="text-ink-2">Provider</dt>
          <dd className="type-engine text-ink">{result.provider}</dd>
          <dt className="text-ink-2">Search key</dt>
          <dd className="text-ink">
            {result.search_key === 'stored'
              ? 'Stored in the OS keychain.'
              : result.search_key === 'skipped'
                ? 'Skipped.'
                : 'Manual setup required.'}
          </dd>
        </dl>

        {result.search_key === 'manual' && result.command !== undefined ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-chip border border-rule bg-sunken px-3 py-2">
            <code className="type-engine text-micro text-ink">{result.command}</code>
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                void copyManualCommand(result.command!);
              }}
            >
              Copy
            </Button>
          </div>
        ) : null}

        <p className="mt-4 text-ink-2">{locationLine}</p>
      </div>

      <nav aria-label="Next steps" className="flex flex-wrap items-center gap-4 text-caption">
        <span className="text-ink-2">Next:</span>
        <RouterLink to="/mission" className={linkStyles()}>
          Mission
        </RouterLink>
        <RouterLink to={MODELS_PATH} className={linkStyles()}>
          Settings → Models
        </RouterLink>
        <RouterLink to="/settings/credentials" className={linkStyles()}>
          Settings → Credentials
        </RouterLink>
      </nav>
    </div>
  );
}
