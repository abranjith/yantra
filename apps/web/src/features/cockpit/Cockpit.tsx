/**
 * The cockpit for one run (FEAT-067): the live run screen assembled from the
 * run stream, the invocation that launched it (when the app did) and the host
 * connection. Each panel is its own component; this one only wires them.
 */

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { CommandInvocation, EffectiveOptions, InvocationSummary } from '@yantra/protocol';
import { BrowserViewport, usePrefersReducedMotion } from '@yantra/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';
import { useConnection } from '../../host/connection-store.js';
import {
  LiveViewTextAlternative,
  liveViewAnnouncement,
} from '../../live-view/live-view-text-alternative.js';
import { useBudgetMonitor } from '../../live-view/use-budget-monitor.js';
import { useLiveView } from '../../live-view/use-live-view.js';
import { forgetLaunched, wasLaunchedHere } from '../composer/submit.js';
import type { CockpitMode } from '../live/cockpit-state.js';
import { deriveDisplayedState } from '../live/displayed-state.js';
import type { RunStream } from '../live/run-stream.js';
import { useRunSnapshot } from '../live/use-run-stream.js';
import { RecoveryActions, priorLabel, useRunRecovery } from '../recovery/RecoveryActions.js';

import { CockpitAnnouncer, announceView } from './CockpitAnnouncer.js';
import { CockpitLayout } from './CockpitLayout.js';
import { CockpitStatus } from './CockpitStatus.js';
import { CockpitTopBar } from './CockpitTopBar.js';
import { CommandPanel } from './CommandPanel.js';
import { EnginePanel } from './EnginePanel.js';
import { finishTransition } from './finish-transition.js';
import { StopControl, stopIsGraceful } from './StopControl.js';
import { UnderstoodPanel } from './UnderstoodPanel.js';

export interface CockpitProps {
  readonly stream: RunStream;
  /** The command word, when the route knows it (invocation or run result). */
  readonly mode?: CockpitMode;
  /** The app invocation that launched the run, when there is one. */
  readonly invocation?: InvocationSummary | null;
}

/** The mode the host resolves for the launched command (for the Stop wording). */
function useResolvedMode(requested: CommandInvocation | null): {
  readonly mode: 'llm' | 'deterministic' | undefined;
  /** False until the host answered (or failed); Stop waits so its wording never flips. */
  readonly settled: boolean;
} {
  const rpc = useRpc();
  const result = useQuery({
    queryKey: ['effective-options', requested?.path, requested?.argv, requested?.cwd, 'cockpit'],
    enabled: requested !== null,
    queryFn: () =>
      rpc.request<EffectiveOptions>('read.effective_options', {
        path: requested?.path,
        argv: requested?.argv,
        cwd: requested?.cwd,
      }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return { mode: result.data?.mode, settled: requested === null || !result.isPending };
}

/** See the module comment. */
export function Cockpit({ stream, mode, invocation = null }: CockpitProps): ReactNode {
  const snapshot = useRunSnapshot(stream);
  const connection = useConnection();
  const rpc = useRpc();
  const [acknowledgedStall, setAcknowledgedStall] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const state = snapshot.cockpit;
  const requested = invocation?.invocation ?? null;
  const resolved = useResolvedMode(requested);
  const graceful = requested === null ? true : stopIsGraceful(requested, state, resolved.mode);
  const displayed = deriveDisplayedState({
    invocation,
    connection,
    channel: snapshot.channel,
    cockpit: state,
    stopping,
    acknowledgedStall,
    gracefulStop: graceful,
  });

  /** One cancel per Stop: a second press while stopping sends nothing. */
  const requestStop = (): void => {
    if (stopping || invocation === null) return;
    setStopping(true);
    setStopError(null);
    rpc
      .request('command.cancel', { invocation_id: invocation.invocation_id })
      .catch((caught: unknown) => {
        setStopping(false);
        setStopError(caught instanceof Error ? caught.message : 'Yantra could not stop this run.');
      });
  };
  const canStop = invocation !== null && state.outcome === null && resolved.settled;
  // A run the app did not launch shows the command rebuilt from its records (TASK-007).
  const recovery = useRunRecovery(state.runId, invocation === null);
  const again = recovery.data?.run_again;
  const [rebuiltCommand, ...rebuiltRest] = again?.path ?? [];
  const reconstructed =
    invocation === null && again?.argv != null && rebuiltCommand !== undefined
      ? {
          invocation: {
            invocation_id: 'reconstructed-twin',
            path: [rebuiltCommand, ...rebuiltRest] as [string, ...string[]],
            argv: [...again.argv],
            cwd: again.cwd ?? '/',
          },
          badge: priorLabel(again.prior) ?? 'From the run’s receipt',
        }
      : null;
  const view = useMemo(() => announceView(state, displayed.kind), [state, displayed.kind]);

  // FEAT-069: the task page, live, behind the HUD; announced once per state change.
  const budget = useBudgetMonitor();
  const live = useLiveView(state.runId, budget.onSample);
  const liveState = live.snapshot.state;
  const previousLiveState = useRef<typeof liveState | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState<{
    readonly id: number;
    readonly text: string;
  } | null>(null);
  useEffect(() => {
    const text = liveViewAnnouncement(previousLiveState.current, liveState);
    previousLiveState.current = liveState;
    if (text !== null) setLiveAnnouncement((prior) => ({ id: (prior?.id ?? 0) + 1, text }));
  }, [liveState]);

  // The finish (TASK-015): only for a run this window launched (it may end before
  // the cockpit attaches) or watched while it ran; a run opened after it ended stays.
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const watchedRunning = useRef(false);
  const finished = useRef(false);
  const [outcomeSpoken, setOutcomeSpoken] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (state.firstSeq !== null && state.outcome === null) watchedRunning.current = true;
  }, [state.firstSeq, state.outcome]);
  // Launched from this window and not yet finished when first seen: it may end
  // before the cockpit attaches, and still finishes into its result. A finished
  // invocation opened again (a reload, a link) stays on the cockpit.
  const launchedLive = useRef<boolean | null>(null);
  useEffect(() => {
    if (invocation === null || launchedLive.current !== null) return;
    launchedLive.current =
      wasLaunchedHere(invocation.invocation_id) ||
      (invocation.state !== 'finished' && invocation.state !== 'discarded');
  }, [invocation]);
  const runId = state.runId;
  useEffect(() => {
    if (!outcomeSpoken || finished.current) return;
    if (!watchedRunning.current && launchedLive.current !== true) return;
    finished.current = true;
    if (invocation !== null) forgetLaunched(invocation.invocation_id);
    void finishTransition({
      navigate: () => navigate({ to: '/runs/$runId', params: { runId } }),
      reducedMotion,
    }).then((result) => {
      if (result === 'held') setHeld(true);
    });
  }, [outcomeSpoken, navigate, reducedMotion, runId, invocation]);
  return (
    <CockpitLayout
      {...(budget.surfaces === undefined ? {} : { surfaces: budget.surfaces })}
      topBar={
        <CockpitTopBar
          state={state}
          displayedKind={displayed.kind}
          {...(mode === undefined ? {} : { mode })}
          stop={
            canStop ? (
              <StopControl graceful={graceful} stopping={stopping} onStop={requestStop} />
            ) : null
          }
        />
      }
      status={
        <>
          {budget.surfaces === 'solid' ? <SolidNotice /> : null}
          <CockpitStatus
            displayed={displayed}
            cockpit={state}
            error={stopError}
            onAction={(action) => {
              if (action.id !== 'cancel' || invocation === null) return false;
              requestStop();
              return true;
            }}
            onKeepWaiting={() => {
              setAcknowledgedStall(state.stalledAt);
            }}
          />
        </>
      }
      backdrop={
        <BrowserViewport
          state={live.snapshot.state}
          reason={live.snapshot.reason}
          page={live.snapshot.page}
          draw={live.attachCanvas}
        />
      }
      understood={<UnderstoodPanel state={state} />}
      engine={
        <>
          <LiveViewTextAlternative snapshot={live.snapshot} />
          <EnginePanel state={state} />
        </>
      }
      command={
        <CommandPanel
          invocation={invocation?.invocation ?? null}
          reconstructed={reconstructed}
          recovery={state.outcome === null ? null : <RecoveryActions runId={state.runId} />}
        />
      }
      announcer={
        <CockpitAnnouncer
          view={view}
          notice={held ? 'The result is ready. View result opens it.' : null}
          liveView={liveAnnouncement}
          onSpoken={(text) => {
            if (text.includes('Run finished:')) setOutcomeSpoken(true);
          }}
        />
      }
    />
  );
}

/**
 * Said once, when the live view went over budget and the cockpit switched
 * itself to Solid (FEAT-069). The preference is unchanged; it says how to
 * keep Glass.
 */
function SolidNotice(): ReactNode {
  return (
    <p data-part="solid-notice" className="type-body rounded-control bg-surface p-3 text-ink-2">
      Switched to Solid to keep the live view smooth. Your <code>ui.surfaces</code> preference is
      unchanged: <code>yantra prefs set ui.surfaces glass</code> keeps Glass for later runs.
    </p>
  );
}
