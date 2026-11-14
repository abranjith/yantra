/**
 * Mission (`/mission`, FEAT-067): the app's start page and the one place to
 * start work. The composer submits once (TASK-011) and lands in the cockpit:
 * `/mission/invocations/<id>` follows the invocation until its run exists.
 */

import { createRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { Composer, type ComposerSubmission } from '../features/composer/Composer.js';
import { SubmitRefusedError, submitInvocation } from '../features/composer/submit.js';
import { useRpc } from '../host/app-rpc.js';

/** The Mission page. */
export function MissionPage(): ReactNode {
  const rpc = useRpc();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Composer onSubmit={onSubmit} submitError={error} />
    </div>
  );
}

/** `/mission`. */
export const missionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mission',
  component: MissionPage,
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
