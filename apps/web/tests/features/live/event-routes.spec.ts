import { RUN_EVENT_KINDS, RunEvent } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  EVENT_ROUTES,
  isInspected,
  isKnownKind,
  routesFor,
  type InstrumentRoute,
} from '../../../src/features/live/event-routes.js';
import { SAMPLE_EVENTS, UNVALIDATED_SAMPLES, isValidRunEvent } from '../../support/run-events.js';

const INSTRUMENTS: readonly InstrumentRoute[] = [
  'timeline',
  'contract',
  'requirements',
  'budgets',
  'top_bar',
  'status',
  'outcome',
  'inspector',
];

/** The kinds of the protocol's runtime union, read from the Zod schema itself. */
function unionKinds(): string[] {
  return RunEvent.options.map((option) => String(option.shape.kind.value));
}

describe('@no-llm event routes', () => {
  it('routes every kind of the runtime RunEvent union to at least one instrument', () => {
    // A runtime assertion: test files are not typechecked (memory -> Testing).
    const unrouted = unionKinds().filter(
      (kind) => (EVENT_ROUTES as Record<string, unknown>)[kind] === undefined,
    );

    expect(unrouted).toEqual([]);
    for (const kind of unionKinds()) expect(routesFor(kind).length).toBeGreaterThan(0);
  });

  it('routes no kind the protocol does not define', () => {
    expect(Object.keys(EVENT_ROUTES).sort()).toEqual(unionKinds().sort());
    expect([...RUN_EVENT_KINDS].sort()).toEqual(unionKinds().sort());
  });

  it('uses only known instruments', () => {
    for (const routes of Object.values(EVENT_ROUTES)) {
      for (const route of routes) expect(INSTRUMENTS).toContain(route);
    }
  });

  it('sends a kind from a newer worker to the inspector only', () => {
    expect(routesFor('screencast_started')).toEqual(['inspector']);
    expect(isInspected('screencast_started')).toBe(true);
    expect(isKnownKind('screencast_started')).toBe(false);
    expect(isKnownKind('toString')).toBe(false);
  });

  it('inspects only the kinds that have no instrument of their own', () => {
    const inspected = Object.keys(EVENT_ROUTES)
      .filter((kind) => isInspected(kind))
      .sort();

    expect(inspected).toEqual([
      'assistant_text',
      'discovery_cycle_completed',
      'discovery_session_completed',
      'event_omitted',
      'receipt_written',
    ]);
  });

  it('has a schema-valid sample for every kind the cockpit suites use', () => {
    const invalid = Object.entries(SAMPLE_EVENTS)
      .filter(([kind]) => !UNVALIDATED_SAMPLES.includes(kind as never))
      .filter(([, event]) => !isValidRunEvent(event))
      .map(([kind]) => kind);

    expect(invalid).toEqual([]);
    expect(Object.keys(SAMPLE_EVENTS).sort()).toEqual(unionKinds().sort());
  });
});
