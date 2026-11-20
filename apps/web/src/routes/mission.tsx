/**
 * Mission (`/mission`, FEAT-067): the app's start page and the one place to
 * start work. The composer submits once (TASK-011) and lands in the cockpit:
 * `/mission/invocations/<id>` follows the invocation until its run exists.
 */

import { useQuery } from '@tanstack/react-query';
import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import type { OnboardingStatus } from '@yantra/protocol';
import { useEffect, useState, type ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { valuesFromArgv, type ComposerPath } from '../features/composer/composer-model.js';
import {
  Composer,
  useMissionContext,
  type ComposerSubmission,
} from '../features/composer/Composer.js';
import { SubmitRefusedError, submitInvocation } from '../features/composer/submit.js';
import { useRunRecovery } from '../features/recovery/RecoveryActions.js';
import { useRpc } from '../host/app-rpc.js';
import { isOnboardingDismissed } from '../surfaces/onboarding/session-dismissal.js';
import { SetupBanner } from '../surfaces/onboarding/setup-banner.js';

/** `?from=<run-id>&settings=current|prior`: prefill from a finished run (Run again → Edit). */
export interface MissionSearch {
  readonly from?: string;
  readonly settings?: 'current' | 'prior';
}

const PATHS: ReadonlySet<string> = new Set(['ask', 'research', 'do', 'run', 'resume']);

/** The composer's starting mode and values for `?from=`, once the run's recovery is read. */
function usePrefill(search: MissionSearch) {
  const recovery = useRunRecovery(search.from ?? '', search.from !== undefined);
  const context = useMissionContext();
  if (search.from === undefined)
    return { ready: true, path: undefined, values: undefined } as const;
  const again = recovery.data?.run_again;
  if (recovery.isError) return { ready: true, path: undefined, values: undefined } as const;
  if (again === undefined || context.data === undefined) return { ready: false } as const;
  const path = again.path?.[0];
  const argv = search.settings === 'prior' ? again.pinned_argv : again.argv;
  if (path === undefined || !PATHS.has(path) || argv === null) {
    return { ready: true, path: undefined, values: undefined } as const;
  }
  const values = valuesFromArgv(path as ComposerPath, argv, context.data.home);
  return values === null
    ? ({ ready: true, path: undefined, values: undefined } as const)
    : ({ ready: true, path: path as ComposerPath, values } as const);
}

/** The Mission page. */
export function MissionPage({ search = {} }: { readonly search?: MissionSearch }): ReactNode {
  const rpc = useRpc();
  const prefill = usePrefill(search);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const onboardingStatus = useQuery({
    queryKey: ['onboarding', 'status'],
    queryFn: () => rpc.request<OnboardingStatus>('read.onboarding_status', {}),
  });

  useEffect(() => {
    if (onboardingStatus.data?.config_exists === false && !isOnboardingDismissed()) {
      void navigate({ to: '/onboarding', replace: true });
    }
  }, [onboardingStatus.data?.config_exists, navigate]);

  const onSubmit = async (submission: ComposerSubmission): Promise<void> => {
    setError(null);
    try {
      const { summary } = await submitInvocation(rpc, submission);
      await navigate({
        to: '/mission/invocations/$invocationId',
        params: { invocationId: summary.invocation_id },
      });
    } catch (caught) {
      if (caught instanceof SubmitRefusedError) {
        setError(
          [caught.message, caught.remediation].filter((part) => part !== undefined).join(' '),
        );
      } else {
        setError(caught instanceof Error ? caught.message : 'Yantra could not start this.');
      }
    }
  };

  if (!prefill.ready) {
    return (
      <p role="status" className="text-ink-2">
        Loading the earlier run…
      </p>
    );
  }
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {onboardingStatus.data?.config_exists === false ? <SetupBanner /> : null}
      <Composer
        key={search.from ?? 'new'}
        onSubmit={onSubmit}
        submitError={error}
        {...(prefill.path === undefined
          ? {}
          : { initialPath: prefill.path, initialValues: { [prefill.path]: prefill.values } })}
      />
    </div>
  );
}

function MissionRoute(): ReactNode {
  return <MissionPage search={missionRoute.useSearch()} />;
}

/** `/mission`. */
export const missionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mission',
  validateSearch: (search: Record<string, unknown>): MissionSearch => ({
    ...(typeof search.from === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(search.from)
      ? { from: search.from }
      : {}),
    ...(search.settings === 'prior' || search.settings === 'current'
      ? { settings: search.settings }
      : {}),
  }),
  component: MissionRoute,
});

/** `/`: Mission is the start page. */
export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's redirect contract.
    throw redirect({ to: '/mission', replace: true });
  },
});
