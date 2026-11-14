/**
 * The cockpit for one run (FEAT-067): the live run screen assembled from the
 * run stream. Each panel is its own component; this one only wires them.
 */

import type { ReactNode } from 'react';

import type { RunStream } from '../live/run-stream.js';
import { useRunSnapshot } from '../live/use-run-stream.js';

import { CockpitLayout } from './CockpitLayout.js';
import { EnginePanel } from './EnginePanel.js';

export interface CockpitProps {
  readonly stream: RunStream;
}

/** See the module comment. */
export function Cockpit({ stream }: CockpitProps): ReactNode {
  const snapshot = useRunSnapshot(stream);
  const state = snapshot.cockpit;
  return (
    <CockpitLayout
      topBar={
        <div data-instrument="top_bar" className="flex flex-wrap items-center gap-3">
          <span className="type-engine text-ink">{state.mode}</span>
          <span className="min-w-0 truncate text-ink">{state.goal ?? ''}</span>
        </div>
      }
      understood={<div data-instrument="contract" />}
      engine={<EnginePanel state={state} />}
      command={<div data-instrument="command" />}
    />
  );
}
