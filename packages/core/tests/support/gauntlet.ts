import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fillField,
  templateFor,
  type FillCause,
  type FillErrorCode,
  type FillIntent,
  type FillOutcome,
  type FillResolution,
  type WidgetPort,
  type WidgetTarget,
} from '../../src/index.js';

import { WidgetTestPort } from './widget-test-port.js';

export type PortActionKind = 'mutation' | 'read' | 'neutral';

/** Exhaustive accounting policy for every operation exposed by {@link WidgetPort}. */
export const PORT_ACTION_KIND = {
  observe: 'read',
  click: 'mutation',
  fill: 'mutation',
  clear: 'mutation',
  type: 'mutation',
  evaluateOn: 'read',
  evaluate: 'read',
  press: 'mutation',
  // Scrolling a virtualized list to reveal its rows is work the page pays for
  // like any click or keystroke; counting it as a read would let a driver
  // reveal an unbounded number of options for free.
  scrollContainer: 'mutation',
  now: 'neutral',
} as const satisfies Record<keyof WidgetPort, PortActionKind>;

export interface PortCounts {
  mutations: number;
  reads: number;
  readonly byAction: Record<string, number>;
}

/** Wrap a widget port with exact, separately reported mutation and read counts. */
export function countingPort(port: WidgetPort): {
  readonly port: WidgetPort;
  readonly counts: PortCounts;
} {
  const counts: PortCounts = { mutations: 0, reads: 0, byAction: {} };
  const count = (action: keyof WidgetPort): void => {
    const kind = PORT_ACTION_KIND[action];
    counts.byAction[action] = (counts.byAction[action] ?? 0) + 1;
    if (kind === 'mutation') counts.mutations += 1;
    if (kind === 'read') counts.reads += 1;
  };
  const wrapped: WidgetPort = {
    observe: (options) => {
      count('observe');
      return port.observe(options);
    },
    click: (ref) => {
      count('click');
      return port.click(ref);
    },
    fill: (ref, value) => {
      count('fill');
      return port.fill(ref, value);
    },
    clear: (ref) => {
      count('clear');
      return port.clear(ref);
    },
    type: (ref, text, options) => {
      count('type');
      return port.type(ref, text, options);
    },
    evaluateOn: (ref, fn, ...args) => {
      count('evaluateOn');
      return port.evaluateOn(ref, fn, ...args);
    },
    evaluate: (fn, ...args) => {
      count('evaluate');
      return port.evaluate(fn, ...args);
    },
    press: (key) => {
      count('press');
      return port.press(key);
    },
    scrollContainer: (container, step) => {
      count('scrollContainer');
      return port.scrollContainer(container, step);
    },
    now: () => {
      count('now');
      return port.now();
    },
  };
  return { port: wrapped, counts };
}

export interface GauntletFollowUp {
  readonly intent: FillIntent;
  readonly committed: string;
}

export type ExpectedOutcome =
  | {
      readonly kind: 'commit';
      readonly committed: string;
      readonly resolution?: FillResolution;
      readonly driver?: string;
      readonly editee?: { readonly name: string; readonly role: string };
      readonly noteContains?: string;
    }
  | {
      readonly kind: 'engineered-refusal';
      readonly errorCode: FillErrorCode;
      readonly cause: FillCause;
      readonly detailKeys: readonly string[];
      readonly followUp: GauntletFollowUp;
    };

export interface GauntletFixture {
  readonly file: string;
  readonly tier: 'protocol';
  readonly pattern: string;
  readonly provenance: { readonly run?: string; readonly site?: string };
  readonly field: { readonly selector: string; readonly role: string; readonly name: string };
  readonly intent: FillIntent;
  readonly expected: ExpectedOutcome;
  readonly expectedMutations: number;
  readonly expectedReads: number;
  readonly expectedToolCalls: null;
  readonly timeoutMs?: number;
}

export interface FixtureResult {
  readonly file: string;
  readonly pattern: string;
  readonly tier: 'protocol';
  readonly outcome: 'commit' | 'engineered-refusal' | 'failed';
  readonly mutations: number;
  readonly reads: number;
  readonly toolCalls: number;
  readonly byAction: Readonly<Record<string, number>>;
}

export interface FixtureRun {
  readonly result: FixtureResult;
  readonly outcome: FillOutcome;
  readonly followUp: FillOutcome | null;
  readonly testPort: WidgetTestPort;
  readonly inputValuesAfterFirst: readonly string[];
}

const RUN_A = '20260827T045106Z-do-9a58de7e';
const RUN_B = '20260829T171218Z-do-0ae073f1';

/** The protocol-tier generic widget gallery. Counts are deliberately exact. */
export const PROTOCOL_GAUNTLET = [
  fixture(
    'dropped-keystroke-input.html',
    'an input that drops an initial keystroke',
    '#q',
    'textbox',
    'Where from?',
    { kind: 'text', text: 'DFW' },
    { kind: 'commit', committed: 'DFW' },
    RUN_A,
    3,
    34,
  ),
  fixture(
    'code-to-label-typeahead.html',
    'a typeahead that resolves a code to a different display label',
    '#q',
    'combobox',
    'Where from?',
    { kind: 'text', text: 'DFW' },
    { kind: 'commit', committed: 'Dallas', resolution: 'single_offered_match' },
    RUN_A,
    2,
    17,
  ),
  fixture(
    'duplicate-trigger-combobox.html',
    'a picker that mounts a duplicate of its own trigger',
    '#page-field',
    'combobox',
    'Where to?',
    { kind: 'text', text: 'San Jose, CA' },
    { kind: 'commit', committed: 'San Jose, CA, United States' },
    RUN_A,
    2,
    17,
  ),
  fixture(
    'readonly-date-trigger.html',
    'a read-only date trigger with a distant month',
    '#trigger',
    'textbox',
    'Choose date',
    { kind: 'date', date: '2026-12-02' },
    { kind: 'commit', committed: 'Dec 2, 2026', driver: 'calendar-grid' },
    RUN_A,
    6,
    32,
  ),
  fixture(
    'late-suggestions.html',
    'a suggestion list that arrives after typing settles',
    '#q',
    'combobox',
    'Going to',
    { kind: 'text', text: 'Reykjavik' },
    { kind: 'commit', committed: 'Reykjavik, Iceland' },
    RUN_A,
    2,
    31,
    25_000,
  ),
  fixture(
    'ambiguous-suggestions.html',
    'two suggestions that match the request equally well',
    '#q',
    'combobox',
    'Going to',
    { kind: 'text', text: 'San Jose' },
    {
      kind: 'engineered-refusal',
      errorCode: 'WIDGET_AMBIGUOUS_CHOICE',
      cause: 'several-matched-equally',
      detailKeys: ['offered', 'hint'],
      followUp: {
        intent: { kind: 'text', text: 'San Jose, Costa Rica' },
        committed: 'San Jose, Costa Rica',
      },
    },
    RUN_A,
    4,
    29,
  ),
  fixture(
    'portal-overlay-combobox.html',
    'a trigger that routes keystrokes into a detached overlay editee',
    '#trigger',
    'combobox',
    'Where from?',
    { kind: 'text', text: 'San Jose' },
    {
      kind: 'commit',
      committed: 'San Jose Mineta International Airport (SJC)',
      editee: { name: 'Search airports', role: 'textbox' },
    },
    RUN_B,
    3,
    22,
    30_000,
  ),
  fixture(
    'prefix-only-matcher.html',
    'a suggestion matcher that accepts only a leading query prefix',
    '#q',
    'combobox',
    'Where to?',
    { kind: 'text', text: 'San Jose Mineta International Airport (SJC)' },
    {
      kind: 'commit',
      committed: 'San Jose Mineta International Airport (SJC)',
      resolution: 'selected_from_offered',
    },
    RUN_B,
    4,
    75,
    30_000,
  ),
  fixture(
    'click-to-reveal-calendar.html',
    'a date field whose calendar exists only after an engine-owned probe',
    '#trigger',
    'textbox',
    'Departure',
    { kind: 'date', date: '2026-12-02' },
    { kind: 'commit', committed: 'Dec 2, 2026', driver: 'calendar-grid' },
    RUN_B,
    6,
    40,
    30_000,
  ),
  fixture(
    'masked-input.html',
    'a control that rewrites input into its own display format',
    '#phone',
    'textbox',
    'Phone number',
    { kind: 'text', text: '5551234567' },
    {
      kind: 'commit',
      committed: '(555) 123-4567',
      resolution: 'reformatted',
      noteContains: 'reformatted',
    },
    RUN_A,
    1,
    33,
  ),
  fixture(
    'split-date-fields.html',
    'one logical range split across two jointly committed inputs',
    '#from',
    'textbox',
    'Check-in',
    { kind: 'date', date: '2026-09-06' },
    {
      kind: 'engineered-refusal',
      errorCode: 'WIDGET_RANGE_INCOMPLETE',
      cause: 'range-half-discarded',
      detailKeys: ['field', 'partner', 'requested', 'hint'],
      followUp: {
        intent: { kind: 'date_range', from: '2026-09-06', to: '2026-10-02' },
        committed: '2026-09-06..2026-10-02',
      },
    },
    RUN_A,
    4,
    40,
  ),
  fixture(
    'shared-calendar-range.html',
    'two range triggers that commit through one shared calendar',
    '#from',
    'textbox',
    'Check-in',
    { kind: 'date_range', from: '2026-09-06', to: '2026-10-02' },
    { kind: 'commit', committed: 'Sep 6, 2026..Oct 2, 2026', driver: 'calendar-grid' },
    RUN_A,
    4,
    39,
  ),
  fixture(
    'virtualized-listbox.html',
    'a listbox that mounts only the rows inside its scroll viewport',
    '#trigger',
    'button',
    'Region',
    { kind: 'option', value: 'Region 6' },
    { kind: 'commit', committed: 'Region 6', driver: 'listbox' },
    RUN_A,
    // 4 mutations: the opening click is skipped (already expanded), three
    // container scrolls reveal the row, one click chooses it. Pinned tightly
    // enough that one extra scroll or one extra window read fails the case —
    // the count is the regression signal, not a bound.
    4,
    18,
  ),
] as const satisfies readonly GauntletFixture[];

/** Execute one descriptor through the same fill seam used by production. */
export async function runFixture(descriptor: GauntletFixture): Promise<FixtureRun> {
  const testPort = new WidgetTestPort(
    readUtf8(join(protocolFixtureDirectory(), descriptor.file)),
    undefined,
    { runScripts: true },
  );
  const counted = countingPort(testPort);
  const identity = {
    field: descriptor.field.name,
    target: target(testPort, descriptor.field),
  };
  const budget = { deadlineMs: testPort.now() + 20_000, maxActions: 32, maxPagingSteps: 12 };
  const outcome = await fillField(counted.port, identity, descriptor.intent, budget);
  const inputValuesAfterFirst = Array.from(testPort.document.querySelectorAll('input')).map(
    (input) => input.value,
  );
  let followUp: FillOutcome | null = null;
  if (descriptor.expected.kind === 'engineered-refusal') {
    if (!templateFor(descriptor.expected.errorCode, descriptor.expected.cause)) {
      throw new Error(
        `Unregistered engineered refusal ${descriptor.expected.errorCode}/${descriptor.expected.cause}`,
      );
    }
    followUp = await fillField(counted.port, identity, descriptor.expected.followUp.intent, budget);
  }
  const kind = outcome.ok
    ? 'commit'
    : descriptor.expected.kind === 'engineered-refusal' &&
        outcome.errorCode === descriptor.expected.errorCode
      ? 'engineered-refusal'
      : 'failed';
  return {
    outcome,
    followUp,
    testPort,
    inputValuesAfterFirst,
    result: {
      file: descriptor.file,
      pattern: descriptor.pattern,
      tier: descriptor.tier,
      outcome: kind,
      mutations: counted.counts.mutations,
      reads: counted.counts.reads,
      toolCalls: 0,
      byAction: { ...counted.counts.byAction },
    },
  };
}

/** Read a text artifact with a strict UTF-8 decoder. */
export function readUtf8(path: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
}

export function protocolFixtureDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'widgets');
}

export function protocolFixtureFiles(): readonly string[] {
  return readdirSync(protocolFixtureDirectory())
    .filter((file) => file.endsWith('.html'))
    .sort();
}

function fixture(
  file: string,
  pattern: string,
  selector: string,
  role: string,
  name: string,
  intent: FillIntent,
  expected: ExpectedOutcome,
  run: string,
  expectedMutations: number,
  expectedReads: number,
  timeoutMs?: number,
): GauntletFixture {
  return {
    file,
    tier: 'protocol',
    pattern,
    provenance: { run },
    field: { selector, role, name },
    intent,
    expected,
    expectedMutations,
    expectedReads,
    expectedToolCalls: null,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function target(port: WidgetTestPort, field: GauntletFixture['field']): WidgetTarget {
  return {
    ref: port.refFor(field.selector),
    role: field.role,
    name: field.name,
    group: null,
    value: null,
  };
}
