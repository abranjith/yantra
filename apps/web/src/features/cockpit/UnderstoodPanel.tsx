/**
 * The Understood panel (FEAT-067 TASK-004): what the run took the goal to
 * mean.
 *
 * - An agentic run's latest `contract_declared` summary in the agent's
 *   italic voice, with its revision, and any capability gaps beneath it.
 * - The ContractRing and the live RequirementList from the latest `progress`.
 * - A deterministic run (`ask`, `research --no-llm`) declares no contract:
 *   the panel shows its current phase and source counts instead, never an
 *   empty ring.
 */

import { ContractRing, LiveRequirementList } from '@yantra/ui';
import type { ReactNode } from 'react';

import type { CockpitState } from '../live/cockpit-state.js';

/** The phase as the CLI names it. */
const PHASE_WORDS: Readonly<Record<NonNullable<CockpitState['phase']>, string>> = {
  search: 'searching',
  fetch: 'fetching sources',
  extract: 'extracting',
  synthesize: 'synthesizing',
};

function Count({ label, value }: { readonly label: string; readonly value: number }): ReactNode {
  return (
    <div className="flex flex-col">
      <dt className="type-label text-ink-2">{label}</dt>
      <dd className="type-engine text-ink">{value}</dd>
    </div>
  );
}

/** The deterministic phase view. */
function PhaseView({ state }: { readonly state: CockpitState }): ReactNode {
  const counts = state.phaseCounts;
  return (
    <div className="flex flex-col gap-3" data-part="phases">
      <p className="text-ink">
        <span className="type-label text-ink-2">Phase </span>
        <span className="type-engine">{state.phase === null ? '—' : PHASE_WORDS[state.phase]}</span>
      </p>
      <dl className="flex flex-wrap gap-6">
        <Count label="Searches" value={counts.searches} />
        <Count label="Sources fetched" value={counts.sourcesOk} />
        <Count label="Sources failed" value={counts.sourcesFailed} />
        <Count label="Extracted" value={counts.extracted} />
      </dl>
    </div>
  );
}

/** See the module comment. */
export function UnderstoodPanel({ state }: { readonly state: CockpitState }): ReactNode {
  const contract = state.contract;
  const deterministic = contract === null && (state.phase !== null || state.mode === 'ask');
  return (
    <div data-instrument="contract" className="flex flex-col gap-4">
      {contract === null ? null : (
        <div className="flex flex-col gap-1" data-part="contract">
          <span className="type-label text-ink-2">Revision {contract.revision}</span>
          <p className="type-agent text-ink">{contract.summary}</p>
        </div>
      )}
      {state.capabilityGaps.length === 0 ? null : (
        <ul className="flex flex-col gap-1" aria-label="Cannot deliver">
          {state.capabilityGaps.map((gap) => (
            <li key={gap.item} role="note" className="text-signal-partial-ink">
              {gap.summary}
            </li>
          ))}
        </ul>
      )}
      {state.requirements.length > 0 ? (
        <div className="flex flex-wrap items-start gap-4" data-instrument="requirements">
          <ContractRing segments={state.requirements} />
          <LiveRequirementList items={state.requirements} className="min-w-0 flex-1" />
        </div>
      ) : null}
      {deterministic ? <PhaseView state={state} /> : null}
      {contract === null && !deterministic && state.requirements.length === 0 ? (
        <p className="text-ink-2">Waiting for the run to say what it will do.</p>
      ) : null}
    </div>
  );
}
