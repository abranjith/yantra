/**
 * The cockpit for one run (FEAT-067): the live run screen assembled from the
 * run stream, the invocation that launched it (when the app did) and the host
 * connection. Each panel is its own component; this one only wires them.
 */

import { useNavigate } from '@tanstack/react-router';
import type { InvocationSummary } from '@yantra/protocol';
import { usePrefersReducedMotion } from '@yantra/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';
import { useConnection } from '../../host/connection-store.js';
import type { CockpitMode } from '../live/cockpit-state.js';
import { deriveDisplayedState } from '../live/displayed-state.js';
import type { RunStream } from '../live/run-stream.js';
import { useRunSnapshot } from '../live/use-run-stream.js';
import { RecoveryActions } from '../recovery/RecoveryActions.js';

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
  const graceful = requested === null ? true : stopIsGraceful(requested, state);
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
  const canStop = invocation !== null && state.outcome === null;
  const view = useMemo(() => announceView(state, displayed.kind), [state, displayed.kind]);

  // The finish (TASK-015): only for a run this window watched while it ran.
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const watchedRunning = useRef(false);
  const finished = useRef(false);
  const [outcomeSpoken, setOutcomeSpoken] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (state.firstSeq !== null && state.outcome === null) watchedRunning.current = true;
  }, [state.firstSeq, state.outcome]);
  const runId = state.runId;
  useEffect(() => {
    if (!outcomeSpoken || !watchedRunning.current || finished.current) return;
    finished.current = true;
    void finishTransition({
      navigate: () => navigate({ to: '/runs/$runId', params: { runId } }),
      reducedMotion,
    }).then((result) => {
      if (result === 'held') setHeld(true);
    });
  }, [outcomeSpoken, navigate, reducedMotion, runId]);
  return (
    <CockpitLayout
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
      }
      understood={<UnderstoodPanel state={state} />}
      engine={<EnginePanel state={state} />}
      command={
        <CommandPanel
          invocation={invocation?.invocation ?? null}
          recovery={state.outcome === null ? null : <RecoveryActions runId={state.runId} />}
        />
      }
      announcer={
        <CockpitAnnouncer
          view={view}
          notice={held ? 'The result is ready. View result opens it.' : null}
          onSpoken={(text) => {
            if (text.includes('Run finished:')) setOutcomeSpoken(true);
          }}
        />
      }
    />
  );
}
