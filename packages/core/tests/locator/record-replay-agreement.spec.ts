// @vitest-environment jsdom

/**
 * Record → persist → replay agreement.
 *
 * A saved workflow is only replayable if the locator written at record time is
 * expressed in the exact terms the resolver uses at replay time. These tests
 * walk the whole production path on a DOM fixture —
 *
 *   rankCandidates            (record: injected ranker, via describeElement)
 *   → intentsToWorkflowCandidates  (persist: _locators block)
 *   → translate()                  (replay: workflow → engine chain)
 *   → resolveCandidate             (replay: injected resolver)
 *
 * — and assert the chain lands back on the element it was recorded from.
 *
 * The regression they guard is a whole class of failure, not one bug: record
 * and replay each had their own role table and accessible-name precedence, so
 * a `<select>` was recorded as `combobox` while the resolver computed
 * `listbox`, and `input[type=search]` was recorded as `textbox` while the
 * resolver computed `searchbox`. Those locators could never match, and the run
 * failed with "locator not found" against a page that had not changed at all.
 */

import type { LocatorCandidate, WorkflowFile } from '@yantra/protocol';
import { describe, expect, it, beforeEach } from 'vitest';

import { intentsToWorkflowCandidates } from '../../src/locator/candidate-codec.js';
import { encodeIntent } from '../../src/locator/intent-codec.js';
import type { JsonLocatorIntent } from '../../src/locator/types.js';
import { translate } from '../../src/workflow/replay/workflow-to-plan.js';

// Registers window.__yantra as a side effect — the same surface the production
// bundle installs in the page.
import '../../src/locator/injected/index.js';

interface InjectedTestApi {
  resolveCandidate(intent: JsonLocatorIntent, strict: boolean): { count: number };
  getSlotElement(): Element | null;
  describeElement(element: Element): { role: string | null; name: string; candidates: unknown[] };
}

function injected(): InjectedTestApi {
  return (globalThis as unknown as { __yantra: InjectedTestApi }).__yantra;
}

/** Mirrors what the agent controller persists for one acted-on element. */
function recordLocator(element: Element): LocatorCandidate[] {
  const described = injected().describeElement(element);
  return intentsToWorkflowCandidates(described.candidates as JsonLocatorIntent[]);
}

/** Builds the engine chain the replay executor would use for those candidates. */
function replayChain(candidates: LocatorCandidate[]) {
  const workflow: WorkflowFile = {
    version: 1,
    name: 'agreement-fixture',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [
      {
        id: 's1',
        verb: 'click',
        scope: null,
        requires_confirmation: false,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        locator: 's1_locator',
      },
    ],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: { s1_locator: candidates },
  };
  return translate(workflow, {}).locatorTable.s1_locator!;
}

/**
 * Runs the full round trip and returns the element the replayed chain lands on,
 * walking candidates in rank order exactly as the resolver does.
 */
function roundTrip(element: Element): { resolved: Element | null; usedIndex: number } {
  const chain = replayChain(recordLocator(element));
  for (let i = 0; i < chain.candidates.length; i++) {
    const intent = encodeIntent(chain.candidates[i]!.intent);
    const { count } = injected().resolveCandidate(intent, chain.strict);
    if (count === 1) return { resolved: injected().getSlotElement(), usedIndex: i };
  }
  return { resolved: null, usedIndex: -1 };
}

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe('@no-llm record → replay locator agreement', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('round-trips a plain button by its accessible name', () => {
    mount('<button id="go">Track</button>');
    const target = document.getElementById('go')!;

    expect(roundTrip(target).resolved).toBe(target);
  });

  it.each([
    ['<label for="t">Country</label><select id="t"><option>US</option></select>', 'listbox'],
    ['<input type="search" id="t" aria-label="Search site">', 'searchbox'],
    ['<input type="number" id="t" aria-label="Quantity">', 'spinbutton'],
    ['<input type="range" id="t" aria-label="Volume">', 'slider'],
  ])('persists the engine-computed role for %s', (html, expectedRole) => {
    // These are the four element kinds where the scanner's simplified role map
    // disagreed with the resolver: `<select>` was recorded as `combobox` but
    // computes `listbox`; search/number/range inputs were all recorded as
    // `textbox`. The persisted chain must carry the role the resolver will
    // actually compute — asserted directly, because a chain that merely
    // round-trips could be surviving on its CSS/XPath fallback while the role
    // candidate is silently wrong or dropped.
    mount(html);
    const target = document.getElementById('t')!;

    expect(injected().describeElement(target).role).toBe(expectedRole);

    const candidates = recordLocator(target);
    const roleCandidate = candidates.find((c) => c.kind === 'role');
    expect(roleCandidate).toBeDefined();
    expect(roleCandidate).toMatchObject({ kind: 'role', role: expectedRole });

    expect(roundTrip(target).resolved).toBe(target);
  });

  it('round-trips a textbox whose accessible name comes from a native label', () => {
    mount(
      '<label for="tn">Enter up to 25 tracking numbers, one per line.</label>' +
        '<input type="text" id="tn">',
    );
    const target = document.getElementById('tn')!;

    expect(roundTrip(target).resolved).toBe(target);
  });

  it('round-trips a button whose text is glued to an icon ligature', () => {
    // Real markup: <button>Track<span class="material-icons">chevron_right</span></button>
    // computes the accessible name "Trackchevron_right". Recording and replay
    // must agree on that exact string, odd as it looks.
    mount('<button id="t">Track<span>chevron_right</span></button>');
    const target = document.getElementById('t')!;

    expect(injected().describeElement(target).name).toBe('Trackchevron_right');
    expect(roundTrip(target).resolved).toBe(target);
  });

  it('round-trips a button whose title attribute differs from its text', () => {
    // Record-time precedence put inner text ahead of `title`; replay put
    // `title` first. A button carrying both resolved to a different name on
    // each side.
    mount('<button id="b" title="Submit the form">Continue</button>');
    const target = document.getElementById('b')!;

    expect(roundTrip(target).resolved).toBe(target);
  });

  it('round-trips a control whose accessible name exceeds the old 200-char cap', () => {
    // The scanner truncated names at 200 chars while the resolver matched the
    // full string, so any long label was permanently unmatchable.
    const longLabel = `Consent ${'x'.repeat(300)}`;
    mount(`<label for="c">${longLabel}</label><input type="checkbox" id="c">`);
    const target = document.getElementById('c')!;

    expect(injected().describeElement(target).name.length).toBeGreaterThan(200);
    expect(roundTrip(target).resolved).toBe(target);
  });

  it('falls through to a narrower candidate when role+name matches a duplicate', () => {
    // Two identical buttons: role+name is genuinely ambiguous, and the ranked
    // chain must carry something that is not.
    mount('<button data-testid="primary-go">Go</button><button>Go</button>');
    const target = document.querySelector('[data-testid="primary-go"]')!;

    const outcome = roundTrip(target);
    expect(outcome.resolved).toBe(target);
    expect(outcome.usedIndex).toBe(0); // testid outranks role+name
  });

  it('resolves via CSS or XPath when the element has neither role nor name', () => {
    mount('<div id="wrap"><span></span><span id="target"></span></div>');
    const target = document.getElementById('target')!;

    expect(roundTrip(target).resolved).toBe(target);
  });

  it('records a chain of more than one candidate so a single miss is survivable', () => {
    mount('<button id="save" class="btn primary">Save</button>');
    const candidates = recordLocator(document.getElementById('save')!);

    expect(candidates.length).toBeGreaterThan(1);
    // Ranked best-first and always terminated by a structural last resort.
    expect(candidates.at(-1)?.kind).toBe('xpath');
  });

  it('never persists a candidate kind the workflow schema cannot express', () => {
    mount('<label id="l">Email<input type="email" id="e"></label>');
    const candidates = recordLocator(document.getElementById('e')!);

    // `relative` anchors and free `text` matchers have no _locators spelling;
    // writing them anyway produced entries replay silently skipped.
    const kinds = new Set(candidates.map((c) => c.kind));
    expect(kinds.has('relative' as never)).toBe(false);
    expect(kinds.has('text' as never)).toBe(false);
    for (const candidate of candidates) {
      expect(['role', 'testid', 'label', 'placeholder', 'css', 'xpath']).toContain(candidate.kind);
    }
  });
});
