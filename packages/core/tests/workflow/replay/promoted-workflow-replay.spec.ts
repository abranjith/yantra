// @vitest-environment jsdom

/**
 * End-to-end replay of a promoted workflow's `_locators` block.
 *
 * The reported failure was a workflow saved by `yantra do --save-as` that ran
 * into "locator not found" on every step, against a page that had not changed.
 * This walks that saved shape — the real one, verbatim — through the
 * translator and the injected resolver against a page built like the site it
 * was recorded from, and asserts each step's locator lands on its element.
 */

import type { LocatorCandidate, WorkflowFile } from '@yantra/protocol';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { encodeIntent } from '../../../src/locator/intent-codec.js';
import { translate } from '../../../src/workflow/replay/workflow-to-plan.js';

import '../../../src/locator/injected/index.js';

interface InjectedTestApi {
  resolveCandidate(intent: unknown, strict: boolean): { count: number };
  getSlotElement(): Element | null;
}

function injected(): InjectedTestApi {
  return (globalThis as unknown as { __yantra: InjectedTestApi }).__yantra;
}

/** The `_locators` block exactly as `do --save-as` wrote it for this workflow. */
const RECORDED_LOCATORS: Record<string, LocatorCandidate[]> = {
  s2_locator: [
    {
      kind: 'role',
      role: 'textbox',
      name: 'Enter up to 25 tracking numbers, one per line.',
    },
  ],
  s3_locator: [{ kind: 'role', role: 'button', name: 'Trackchevron_right' }],
  s4_locator: [{ kind: 'css', value: 'body' }],
};

function buildWorkflow(locators: Record<string, LocatorCandidate[]>): WorkflowFile {
  return {
    version: 1,
    name: 'test-ups-track',
    description: 'Promoted from a discovery run.',
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [
      {
        id: 's1',
        verb: 'navigate',
        scope: null,
        requires_confirmation: false,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        url: 'https://www.ups.com/track?loc=en_US',
      },
      {
        id: 's2',
        verb: 'fill',
        scope: null,
        requires_confirmation: false,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        locator: 's2_locator',
        value: '1Z07K6T30397135835',
        submit: false,
      },
      {
        id: 's3',
        verb: 'click',
        scope: null,
        requires_confirmation: false,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        locator: 's3_locator',
      },
      {
        id: 's4',
        verb: 'extract',
        scope: null,
        requires_confirmation: false,
        locator: 's4_locator',
        extraction_schema: { type: 'primitive', kind: 'string' },
        capture_as: 'extracted_content_1',
      },
    ],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: locators,
  };
}

/** Resolves a named locator the way the executor's auto-wait loop would. */
function resolve(locatorName: string, locators = RECORDED_LOCATORS): Element | null {
  const chain = translate(buildWorkflow(locators), {}).locatorTable[locatorName]!;
  for (const candidate of chain.candidates) {
    const { count } = injected().resolveCandidate(encodeIntent(candidate.intent), chain.strict);
    if (count === 1) return injected().getSlotElement();
  }
  return null;
}

const originalGetRect = Element.prototype.getBoundingClientRect;

describe('@no-llm promoted workflow replay', () => {
  beforeEach(() => {
    // A carrier tracking page: a labelled tracking-number field, a Track button
    // whose label runs into an icon ligature, and a hidden mobile duplicate of
    // both — the shape that made these locators ambiguous at replay.
    document.body.innerHTML = `
      <div id="mobile-nav" hidden>
        <label for="tn-m">Enter up to 25 tracking numbers, one per line.</label>
        <input type="text" id="tn-m">
        <button id="track-m">Track<span>chevron_right</span></button>
      </div>
      <main>
        <label for="tn">Enter up to 25 tracking numbers, one per line.</label>
        <input type="text" id="tn">
        <button id="track">Track<span>chevron_right</span></button>
        <section id="results">Delivered</section>
      </main>`;
    const visible = new Set<Element>([
      document.getElementById('tn')!,
      document.getElementById('track')!,
      document.body,
    ]);
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return visible.has(this)
        ? ({
            top: 0,
            left: 0,
            width: 200,
            height: 40,
            right: 200,
            bottom: 40,
            x: 0,
            y: 0,
          } as DOMRect)
        : ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 } as DOMRect);
    };
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalGetRect;
    document.body.innerHTML = '';
  });

  it('resolves the tracking-number field past its hidden mobile duplicate', () => {
    expect(resolve('s2_locator')).toBe(document.getElementById('tn'));
  });

  it('resolves the Track button whose name runs into an icon ligature', () => {
    expect(resolve('s3_locator')).toBe(document.getElementById('track'));
  });

  it('resolves the body locator recorded for the extract step', () => {
    expect(resolve('s4_locator')).toBe(document.body);
  });

  it('resolves a nameless recorded role rather than demanding an empty name', () => {
    // The other half of the promoted shape: when the model proposes no name,
    // the promoter writes `name: ''`. Read as a matcher, that demanded an
    // element whose accessible name is empty — here, neither Track button.
    const resolved = resolve('s3_locator', {
      ...RECORDED_LOCATORS,
      s3_locator: [{ kind: 'role', role: 'button', name: '' }],
    });

    expect(resolved).toBe(document.getElementById('track'));
  });
});
