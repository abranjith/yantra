// @no-llm
/**
 * FEAT-069 TASK-004: the focus guard's in-page classifier, run from its
 * shipped source in jsdom and held to `classifyWithheld` by the shared
 * parity table. The real-Chrome twin is `focus-guard.chrome.spec.ts`.
 */
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyWithheld } from '../../src/interaction/protected-value.js';
import {
  FOCUS_GUARD_OBSERVED_ATTRIBUTES,
  focusGuardSource,
  liveViewFocusGuard,
} from '../../src/live-view/focus-guard.js';
import { protectedInputMarkup, WITHHELD_FACTS_TABLE } from '../support/protected-facts.js';

const BINDING = '__yantraLiveView_test';

/** Every window a test opened; the guard's poll keeps its timers alive until closed. */
const opened: JSDOM['window'][] = [];
afterEach(() => {
  for (const window of opened.splice(0)) window.close();
});

interface GuardedWindow {
  readonly window: JSDOM['window'];
  readonly document: Document;
  readonly reports: string[];
  readonly settle: () => Promise<void>;
}

function guarded(body: string, options: { readonly binding?: boolean } = {}): GuardedWindow {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  opened.push(dom.window);
  const reports: string[] = [];
  if (options.binding !== false) {
    (dom.window as unknown as Record<string, unknown>)[BINDING] = (state: string) => {
      reports.push(state);
    };
  }
  // Evaluated from source, exactly as the page receives it, so a closure over
  // a module value would break here rather than only in Chrome.
  dom.window.eval(focusGuardSource(BINDING));
  return {
    window: dom.window,
    document: dom.window.document,
    reports,
    settle: () => new Promise((resolve) => dom.window.setTimeout(resolve, 5)),
  };
}

const last = (reports: readonly string[]): string | undefined => reports[reports.length - 1];

describe('@no-llm focus guard classifier parity (jsdom)', () => {
  it.each(WITHHELD_FACTS_TABLE.map((row) => [row.label, row] as const))(
    '%s agrees with classifyWithheld',
    (_label, row) => {
      const page = guarded(protectedInputMarkup(row, 'CANARY-value'));
      page.document.querySelector('input')!.focus();
      expect(last(page.reports)).toBe(classifyWithheld(row.facts) === null ? 'clear' : 'protected');
    },
  );

  it('reports clear at install when nothing has focus', () => {
    expect(guarded('<input>').reports).toEqual(['clear']);
  });

  it('reports protected on focus and clear after blur', async () => {
    const page = guarded('<input id="pw" type="password"><input id="q">');
    page.document.querySelector<HTMLInputElement>('#pw')!.focus();
    expect(last(page.reports)).toBe('protected');
    page.document.querySelector<HTMLInputElement>('#pw')!.blur();
    await page.settle();
    expect(last(page.reports)).toBe('clear');
  });

  it('moves straight from protected to clear without a flicker', async () => {
    const page = guarded('<input id="pw" type="password"><input id="q">');
    page.document.querySelector<HTMLInputElement>('#pw')!.focus();
    page.document.querySelector<HTMLInputElement>('#q')!.focus();
    await page.settle();
    expect(page.reports).toEqual(['clear', 'protected', 'clear']);
  });

  it('follows a type change on the focused field, both ways', async () => {
    const page = guarded('<input id="f" type="password">');
    const field = page.document.querySelector<HTMLInputElement>('#f')!;
    field.focus();
    expect(last(page.reports)).toBe('protected');
    field.setAttribute('type', 'text');
    await page.settle();
    expect(last(page.reports)).toBe('clear');
    field.setAttribute('type', 'password');
    await page.settle();
    expect(last(page.reports)).toBe('protected');
  });

  it('follows the autocomplete and marker attributes on the focused field', async () => {
    const page = guarded('<input id="f">');
    const field = page.document.querySelector<HTMLInputElement>('#f')!;
    field.focus();
    field.setAttribute('autocomplete', 'one-time-code');
    await page.settle();
    expect(last(page.reports)).toBe('protected');
    field.removeAttribute('autocomplete');
    await page.settle();
    expect(last(page.reports)).toBe('clear');
    field.setAttribute('data-yantra-secret', '');
    await page.settle();
    expect(last(page.reports)).toBe('protected');
  });

  it('ignores attribute changes on an element that does not have focus', async () => {
    const page = guarded('<input id="a"><input id="b">');
    page.document.querySelector<HTMLInputElement>('#a')!.focus();
    page.document.querySelector('#b')!.setAttribute('type', 'password');
    await page.settle();
    expect(page.reports).toEqual(['clear']);
  });

  it('sees through an open shadow root', () => {
    const page = guarded('<x-host></x-host>');
    const host = page.document.querySelector('x-host')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input type="password">';
    root.querySelector('input')!.focus();
    expect(last(page.reports)).toBe('protected');
  });

  it('reports unknown for focus a closed shadow root hides', () => {
    const page = guarded('<x-secret></x-secret>');
    const host = page.document.querySelector('x-secret')!;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<input id="inner">';
    root.querySelector('input')!.focus();
    expect(last(page.reports)).toBe('unknown');
  });

  it('classifies a focusable custom element by itself', () => {
    const page = guarded('<x-button tabindex="0"></x-button>');
    page.document.querySelector<HTMLElement>('x-button')!.focus();
    expect(last(page.reports)).toBe('clear');
  });

  it('only reports a change, never a repeat', () => {
    const page = guarded('<input id="a" type="password"><input id="b" type="password">');
    page.document.querySelector<HTMLInputElement>('#a')!.focus();
    page.document.querySelector<HTMLInputElement>('#b')!.focus();
    expect(page.reports).toEqual(['clear', 'protected']);
  });

  it('rebinds instead of double-installing when evaluated again', async () => {
    const page = guarded('<input type="password">');
    page.document.querySelector('input')!.focus();
    const second: string[] = [];
    (page.window as unknown as Record<string, unknown>)['__yantraLiveView_second'] = (
      state: string,
    ) => {
      second.push(state);
    };
    const before = page.reports.length;
    page.window.eval(focusGuardSource('__yantraLiveView_second'));
    // The new binding hears the current state at once; the old one hears nothing more.
    expect(second).toEqual(['protected']);
    page.document.querySelector('input')!.blur();
    await page.settle();
    page.document.querySelector('input')!.focus();
    expect(second).toEqual(['protected', 'clear', 'protected']);
    expect(page.reports).toHaveLength(before);
  });

  it('notices a focus change that fires no events, through its poll', async () => {
    const page = guarded('<input id="pw" type="password">');
    const field = page.document.querySelector<HTMLInputElement>('#pw')!;
    // Chrome's background tab: activeElement moves and no focus event fires.
    Object.defineProperty(page.document, 'activeElement', { configurable: true, get: () => field });
    await new Promise((resolve) => page.window.setTimeout(resolve, 250));
    expect(last(page.reports)).toBe('protected');
  });

  it('does nothing harmful without its binding', () => {
    const page = guarded('<input type="password">', { binding: false });
    expect(() => page.document.querySelector('input')!.focus()).not.toThrow();
    expect(page.reports).toEqual([]);
  });

  it('never mutates the document across a focus cycle', async () => {
    const dom = new JSDOM(
      '<!doctype html><body><input id="pw" type="password"><input id="q"></body>',
      {
        runScripts: 'outside-only',
      },
    );
    opened.push(dom.window);
    const mutations: MutationRecord[] = [];
    const observer = new dom.window.MutationObserver((records) => mutations.push(...records));
    observer.observe(dom.window.document, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    (dom.window as unknown as Record<string, unknown>)[BINDING] = () => undefined;
    dom.window.eval(focusGuardSource(BINDING));
    dom.window.document.querySelector<HTMLInputElement>('#pw')!.focus();
    dom.window.document.querySelector<HTMLInputElement>('#q')!.focus();
    dom.window.document.querySelector<HTMLInputElement>('#q')!.blur();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    observer.disconnect();
    expect(mutations).toEqual([]);
  });

  it('ships the token vocabulary as a JSON literal, not a reference', () => {
    const source = focusGuardSource(BINDING);
    expect(source).toContain('"current-password"');
    expect(source).toContain('"cc-number"');
    expect(source).toContain(JSON.stringify(BINDING));
    expect(source.startsWith(`(${liveViewFocusGuard.toString()})`)).toBe(true);
  });

  it('observes exactly the attributes the classifier reads', () => {
    const source = liveViewFocusGuard.toString();
    for (const attribute of FOCUS_GUARD_OBSERVED_ATTRIBUTES) {
      expect(source).toMatch(new RegExp(`["']${attribute}["']`, 'u'));
    }
  });
});
