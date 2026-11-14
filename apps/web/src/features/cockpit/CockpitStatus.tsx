/**
 * The cockpit's status line (FEAT-067 TASK-005): the displayed state in a
 * RunStatusBanner, with each next action wired to its engineered path.
 *
 * - `rpc`: the host call, once at a time per action; a refusal is shown inline.
 * - `href`: an app route.
 * - `local`: reconnect now, or acknowledge a stall and keep waiting.
 * - `twin`: shown as a command to copy, not a button (until FEAT-068 adds
 *   in-app answers).
 * - `confirm`: an alert dialog first, whose default focus is Cancel.
 */

import { useNavigate } from '@tanstack/react-router';
import {
  Button,
  Dialog,
  RunStatusBanner,
  type StatusBannerAction,
  type StatusBannerTone,
} from '@yantra/ui';
import { useState, type ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';
import type { CockpitState } from '../live/cockpit-state.js';
import {
  DISPLAYED_WORDS,
  type DisplayedKind,
  type DisplayedState,
  type NextAction,
} from '../live/displayed-state.js';

import { InvocationTwin, displayInvocation } from './cli-twin.js';

const KIND_TONE: Readonly<Record<DisplayedKind, StatusBannerTone>> = {
  disconnected: 'caution',
  live_view_unavailable: 'caution',
  worker_not_responding: 'caution',
  needs_review: 'attention',
  start_unknown: 'caution',
  waiting_for_you: 'attention',
  stopping: 'neutral',
  engine_stalled: 'caution',
  finished: 'neutral',
  running: 'neutral',
  starting: 'neutral',
  queued: 'neutral',
};

/** The banner tone for a displayed state; a finished run takes its outcome's tone. */
export function statusTone(
  displayed: DisplayedState,
  cockpit: CockpitState | null,
): StatusBannerTone {
  if (displayed.kind !== 'finished' || cockpit?.outcome == null) return KIND_TONE[displayed.kind];
  if (cockpit.outcome.executionState === 'interrupted') return 'caution';
  switch (cockpit.outcome.outcome) {
    case 'fulfilled':
      return 'fulfilled';
    case 'failed':
      return 'failed';
    case 'aborted':
      return 'neutral';
    case 'partial':
    case 'handoff':
      return 'caution';
  }
}

export interface CockpitStatusProps {
  readonly displayed: DisplayedState;
  readonly cockpit: CockpitState | null;
  /**
   * Handles an action before the default path; returns true when it did
   * (the Stop control takes `cancel`, TASK-008).
   */
  readonly onAction?: (action: NextAction) => boolean;
  /** "Keep waiting" through the current stall. */
  readonly onKeepWaiting?: () => void;
}

/** See the module comment. */
export function CockpitStatus({
  displayed,
  cockpit,
  onAction,
  onKeepWaiting,
}: CockpitStatusProps): ReactNode {
  const rpc = useRpc();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<NextAction | null>(null);

  const perform = (action: NextAction): void => {
    if (onAction?.(action) === true) return;
    if (action.rpc !== undefined) {
      setBusy(action.id);
      setError(null);
      rpc.request(action.rpc.method, { ...action.rpc.params }).then(
        () => {
          setBusy(null);
        },
        (caught: unknown) => {
          setBusy(null);
          setError(caught instanceof Error ? caught.message : 'Yantra refused that.');
        },
      );
      return;
    }
    if (action.href !== undefined) {
      void navigate({ to: action.href });
      return;
    }
    if (action.local === 'reconnect') rpc.reconnectNow?.();
    if (action.local === 'keep_waiting') onKeepWaiting?.();
  };

  const buttons: StatusBannerAction[] = displayed.nextActions
    .filter((action) => action.twin === undefined)
    .map((action) => ({
      id: action.id,
      label: action.label,
      ...(action.tone === undefined ? {} : { tone: action.tone }),
      isDisabled: busy !== null,
      onPress: () => {
        if (action.confirm === undefined) perform(action);
        else setConfirming(action);
      },
    }));
  const twins = displayed.nextActions.filter((action) => action.twin !== undefined);

  return (
    <>
      <RunStatusBanner
        word={DISPLAYED_WORDS[displayed.kind]}
        detail={displayed.detail}
        tone={statusTone(displayed, cockpit)}
        actions={buttons}
      >
        {twins.map((action) =>
          action.twin === undefined ? null : (
            <InvocationTwin
              key={action.id}
              label={action.label}
              invocation={displayInvocation(action.twin.path, action.twin.argv)}
            />
          ),
        )}
        {error === null ? null : (
          <p role="alert" className="text-signal-failed-ink">
            {error}
          </p>
        )}
      </RunStatusBanner>
      {confirming?.confirm === undefined ? null : (
        <Dialog
          title={confirming.confirm.title}
          role="alertdialog"
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
        >
          {({ close }) => (
            <>
              <p className="text-ink-2">{confirming.confirm?.body}</p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" autoFocus onPress={close}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onPress={() => {
                    const action = confirming;
                    close();
                    perform(action);
                  }}
                >
                  {confirming.label}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
