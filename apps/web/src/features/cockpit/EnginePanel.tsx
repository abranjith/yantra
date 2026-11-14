/**
 * The Engine panel (FEAT-067 TASK-002): the RunTimeline, and every event no
 * instrument shows in an "Other events" disclosure through FEAT-066's
 * EventInspector, including kinds from a newer worker (plan D17).
 */

import {
  Button,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  EventInspector,
  RunTimeline,
} from '@yantra/ui';
import { useState, type ReactNode } from 'react';

import { firstIndex, logEntries } from '../live/bounded-log.js';
import type { CockpitState } from '../live/cockpit-state.js';

/** Inspector entries rendered at first, and per "Show more". */
export const INSPECTOR_PAGE = 50;

/** The events routed to the inspector, newest last. */
export function OtherEvents({ state }: { readonly state: CockpitState }): ReactNode {
  const [shown, setShown] = useState(INSPECTOR_PAGE);
  const entries = logEntries(state.inspected);
  if (entries.length === 0) return null;
  const visible = entries.slice(Math.max(0, entries.length - shown));
  const hidden = state.inspected.total - visible.length;
  return (
    <div data-instrument="inspector">
      <Disclosure>
        <DisclosureTrigger headingLevel={3}>
          Other events ({state.inspected.total})
        </DisclosureTrigger>
        <DisclosurePanel>
          <div className="flex flex-col gap-3">
            {hidden > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-caption text-ink-2">
                  {hidden} earlier {hidden === 1 ? 'event is' : 'events are'} in the run’s event
                  log.
                </p>
                {visible.length < entries.length ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    onPress={() => {
                      setShown((count) => count + INSPECTOR_PAGE);
                    }}
                  >
                    Show more
                  </Button>
                ) : null}
              </div>
            ) : null}
            <ol className="flex flex-col gap-2" aria-label="Other events">
              {visible.map((item) => (
                <li key={item.seq} data-seq={item.seq} className="flex flex-col gap-1">
                  <span className="type-engine text-ink-2">
                    #{item.seq} {item.kind}
                    {item.unknown ? ' (from a newer Yantra)' : ''}
                  </span>
                  <EventInspector
                    value={item.event}
                    label={`Event ${String(item.seq)}: ${item.kind}`}
                  />
                </li>
              ))}
            </ol>
          </div>
        </DisclosurePanel>
      </Disclosure>
    </div>
  );
}

/** The current call: the newest tool call still running. */
function currentSeq(state: CockpitState): number | null {
  const open = state.openTools.at(-1);
  if (open === undefined) return null;
  const entries = logEntries(state.timeline);
  const row = entries[open.index - firstIndex(state.timeline)];
  return row?.seq ?? null;
}

/** See the module comment. */
export function EnginePanel({ state }: { readonly state: CockpitState }): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <RunTimeline
        entries={logEntries(state.timeline)}
        omitted={firstIndex(state.timeline)}
        currentSeq={currentSeq(state)}
      />
      <OtherEvents state={state} />
    </div>
  );
}
