/**
 * The cockpit for one run (FEAT-067): the live run screen assembled from the
 * run stream. Each panel is its own component; this one only wires them.
 */

import type { ReactNode } from 'react';

import type { CockpitMode } from '../live/cockpit-state.js';
import type { RunStream } from '../live/run-stream.js';
import { useRunSnapshot } from '../live/use-run-stream.js';

import { CockpitLayout } from './CockpitLayout.js';
import { CockpitTopBar } from './CockpitTopBar.js';
import { EnginePanel } from './EnginePanel.js';
import { UnderstoodPanel } from './UnderstoodPanel.js';

export interface CockpitProps {
  readonly stream: RunStream;
  /** The command word, when the route knows it (invocation or run result). */
  readonly mode?: CockpitMode;
}

/** See the module comment. */
export function Cockpit({ stream, mode }: CockpitProps): ReactNode {
  const snapshot = useRunSnapshot(stream);
  const state = snapshot.cockpit;
  return (
    <CockpitLayout
      topBar={<CockpitTopBar state={state} {...(mode === undefined ? {} : { mode })} />}
      understood={<UnderstoodPanel state={state} />}
      engine={<EnginePanel state={state} />}
      command={<div data-instrument="command" />}
    />
  );
}
