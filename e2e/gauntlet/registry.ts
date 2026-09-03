import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type AgentBrowserController, type ObstructionKind } from '@yantra/core';

export interface ControllerCounts {
  mutations: number;
  reads: number;
  readonly byAction: Record<string, number>;
}

/** Facts every agent-tier descriptor declares, whatever it exercises. */
interface AgentFixtureBase {
  readonly file: string;
  readonly tier: 'agent-real-browser';
  readonly pattern: string;
  readonly provenance: { readonly run?: string; readonly site?: string };
  readonly expectedMutations: number;
  readonly expectedReads: number;
  readonly expectedToolCalls: number;
  /**
   * Engine-initiated obstruction clearances, counted from the returned ledger.
   *
   * Deliberately its own number rather than part of `expectedMutations`: the
   * clearance is a raw pointer dispatch at the coordinate the hit test was
   * given, not a controller `click`, because testing and dispatching the same
   * value object is the whole guarantee. This is the count that moves first if
   * the one-per-tool-call bound regresses.
   */
  readonly expectedClearances: number;
}

/** A fixture driven through `browser_fill_element`. */
export interface AgentFillFixture extends AgentFixtureBase {
  readonly exercise: 'fill';
  readonly field: { readonly role: string; readonly name: string };
  readonly value: string;
  readonly expectedCommitted: string;
  /**
   * A control to replace after the fill, to prove the ref then goes stale.
   *
   * Declared per fixture rather than assumed: the staleness contract is only
   * meaningful where the pattern is a page that remounts its controls, and a
   * fixture that does not remount has nothing to say about it.
   */
  readonly remountSelector?: string;
}

/** A fixture driven through `browser_click` against an obstructed control. */
export interface AgentClickFixture extends AgentFixtureBase {
  readonly exercise: 'click';
  readonly control: { readonly role: string; readonly name: string };
  readonly expected:
    | {
        /** The action actually happened; `verify` proves it on the page itself. */
        readonly kind: 'commit';
        readonly verify: { readonly selector: string; readonly text: string };
      }
    | {
        /** A refusal the engine designed, not a frozen unknown failure. */
        readonly kind: 'engineered-refusal';
        readonly errorCode: 'ELEMENT_OBSTRUCTED';
        readonly obstructionKind: ObstructionKind;
        readonly candidates: number;
        readonly clearanceSkipped: string;
        /** The move the failure's own hint tells the agent to make next. */
        readonly followUp: 'scroll-and-reissue';
      };
}

export type AgentGauntletFixture = AgentFillFixture | AgentClickFixture;

/**
 * The agent real-browser gallery.
 *
 * Annotated with the union rather than left as a literal tuple: the two tiers
 * are discriminated by `exercise`, and a caller filtering to one arm needs the
 * declared shape, not the frozen literal of each individual row.
 */
export const AGENT_GAUNTLET: readonly AgentGauntletFixture[] = [
  {
    file: 'remounting-search-form.html',
    tier: 'agent-real-browser',
    pattern: 'a search form that remounts its input while text is entered',
    provenance: {},
    exercise: 'fill',
    field: { role: 'textbox', name: 'Search catalog' },
    value: 'winter coat',
    expectedCommitted: 'winter coat',
    expectedMutations: 3,
    expectedReads: 13,
    expectedToolCalls: 1,
    expectedClearances: 0,
    remountSelector: '#query',
  },
  {
    file: 'open-shadow-select.html',
    tier: 'agent-real-browser',
    pattern: 'a native select the page encapsulates inside a component shadow tree',
    provenance: {},
    exercise: 'fill',
    field: { role: 'combobox', name: 'Delivery speed' },
    value: 'Express',
    expectedCommitted: 'Express',
    // One `fill` and nothing else: a shadow-hosted native select is an
    // ordinary control once the composed tree is walked, and costs exactly
    // what a light-DOM one costs. An extra diagnostic read on this path — the
    // temptation whenever a new capability lands — fails the case.
    expectedMutations: 1,
    expectedReads: 7,
    expectedToolCalls: 1,
    expectedClearances: 0,
  },
  {
    file: 'consent-modal-obstruction.html',
    tier: 'agent-real-browser',
    pattern: 'a page-blocking modal over the control the caller asked for',
    provenance: {},
    exercise: 'click',
    control: { role: 'button', name: 'Apply filters' },
    expected: { kind: 'commit', verify: { selector: '#status', text: 'applied' } },
    expectedMutations: 1,
    // One post-action observation. The obstruction-scoped candidate scan is an
    // internal controller read and is invisible to this decorator, which wraps
    // the controller from outside; it is pinned directly in
    // `packages/core/tests/browser/agent-controller.spec.ts`.
    expectedReads: 1,
    expectedToolCalls: 1,
    expectedClearances: 1,
  },
  {
    file: 'sticky-header-interception.html',
    tier: 'agent-real-browser',
    pattern: 'a viewport-pinned band that owns the click point of an in-view control',
    provenance: {},
    exercise: 'click',
    control: { role: 'button', name: 'Apply filters' },
    expected: {
      kind: 'engineered-refusal',
      errorCode: 'ELEMENT_OBSTRUCTED',
      obstructionKind: 'fixed-overlay',
      // A pinned band has no dismiss control inside it. That is the pattern:
      // there is nothing to press, and the report says so rather than guessing.
      candidates: 0,
      clearanceSkipped: 'no-eligible-candidate',
      followUp: 'scroll-and-reissue',
    },
    expectedMutations: 1,
    // A refused action takes no post-action observation, and a band with no
    // dismiss-shaped control inside it is never described.
    expectedReads: 0,
    expectedToolCalls: 1,
    expectedClearances: 0,
  },
] as const satisfies readonly AgentGauntletFixture[];

/** Count controller operations while preserving the real class and private state. */
export function countingController(controller: AgentBrowserController): {
  readonly controller: AgentBrowserController;
  readonly counts: ControllerCounts;
  reset(): void;
} {
  const counts: ControllerCounts = { mutations: 0, reads: 0, byAction: {} };
  const mutationNames = new Set(['click', 'fill', 'clear', 'type', 'press']);
  const readNames = new Set(['observe', 'evaluate', 'evaluateOn']);
  const wrapped = new Proxy(controller, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const bound = value.bind(target) as (...args: readonly unknown[]) => unknown;
      if (!mutationNames.has(property) && !readNames.has(property)) return bound;
      return (...args: readonly unknown[]) => {
        counts.byAction[property] = (counts.byAction[property] ?? 0) + 1;
        if (mutationNames.has(property)) counts.mutations += 1;
        else counts.reads += 1;
        return bound(...args);
      };
    },
  });
  return {
    controller: wrapped,
    counts,
    reset: () => {
      counts.mutations = 0;
      counts.reads = 0;
      for (const key of Object.keys(counts.byAction)) delete counts.byAction[key];
    },
  };
}

export function agentFixtureDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'site', 'gauntlet');
}

export function agentFixtureFiles(): readonly string[] {
  return readdirSync(agentFixtureDirectory())
    .filter((file) => file.endsWith('.html'))
    .sort();
}
