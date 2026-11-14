/**
 * The cockpit for one run (FEAT-067): the live run screen assembled from the
 * run stream, the invocation that launched it (when the app did) and the host
 * connection. Each panel is its own component; this one only wires them.
 */

import type { InvocationSummary } from '@yantra/protocol';
import { useMemo, useState, type ReactNode } from 'react';

import { useConnection } from '../../host/connection-store.js';
import type { CockpitMode } from '../live/cockpit-state.js';
import { deriveDisplayedState } from '../live/displayed-state.js';
import type { RunStream } from '../live/run-stream.js';
import { useRunSnapshot } from '../live/use-run-stream.js';

import { CockpitAnnouncer, announceView } from './CockpitAnnouncer.js';
import { CockpitLayout } from './CockpitLayout.js';
import { CockpitStatus } from './CockpitStatus.js';
import { CockpitTopBar } from './CockpitTopBar.js';
import { CommandPanel } from './CommandPanel.js';
import { EnginePanel } from './EnginePanel.js';
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
  const [acknowledgedStall, setAcknowledgedStall] = useState<number | null>(null);
  const state = snapshot.cockpit;
  const displayed = deriveDisplayedState({
    invocation,
    connection,
    channel: snapshot.channel,
    cockpit: state,
    stopping: false,
    acknowledgedStall,
  });
  const view = useMemo(() => announceView(state, displayed.kind), [state, displayed.kind]);
  return (
    <CockpitLayout
      topBar={
        <CockpitTopBar
          state={state}
          displayedKind={displayed.kind}
          {...(mode === undefined ? {} : { mode })}
        />
      }
      status={
        <CockpitStatus
          displayed={displayed}
          cockpit={state}
          onKeepWaiting={() => {
            setAcknowledgedStall(state.stalledAt);
          }}
        />
      }
      understood={<UnderstoodPanel state={state} />}
      engine={<EnginePanel state={state} />}
      command={<CommandPanel invocation={invocation?.invocation ?? null} />}
      announcer={<CockpitAnnouncer view={view} />}
    />
  );
}
