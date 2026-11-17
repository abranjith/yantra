/**
 * Protected-control focus guard (FEAT-069 TASK-004).
 *
 * While a live view streams, the task page must be hidden whenever a FEAT-056
 * protected control (password, sensitive `autocomplete`, `data-yantra-secret`)
 * has focus, because the screencast would show what is typed there. This
 * module installs a small reporter in an **isolated world** of every document
 * of the task page:
 *
 * - it only adds listeners (`focusin`/`focusout` on `window`, and an
 *   attribute observer on the focused element) and never mutates the DOM
 *   (memory: detection must not mutate page state);
 * - it reports `protected | clear | unknown` through a CDP binding that exists
 *   only in that isolated world, so main-world scripts can neither see nor call
 *   it;
 * - focus inside a cross-origin iframe or a closed shadow root is `unknown`,
 *   which the live view treats as protected (fail closed).
 *
 * Installed only while a screencast stream is active; the hub re-installs it on
 * a target change.
 */

import { randomBytes } from 'node:crypto';

import type { CDPSession, Page as PuppeteerPage } from 'puppeteer-core';

import type { ProtectedFocusState } from '../browser/screen-protection.js';
import { SENSITIVE_AUTOCOMPLETE_TOKENS } from '../interaction/protected-value.js';

import { LiveViewError } from './errors.js';

/** The isolated world the guard runs in. */
export const LIVE_VIEW_WORLD = 'yantra-live-view';

/**
 * How often the guard re-reads focus. Chrome fires no focus events in a tab
 * that does not have focus (a background or adopted headless page) although
 * `activeElement` still moves, so events alone would miss it (verified
 * against real Chrome). The read is a handful of DOM property accesses.
 */
export const FOCUS_GUARD_POLL_MS = 100;

/** Attributes whose change on the focused element can change its classification. */
export const FOCUS_GUARD_OBSERVED_ATTRIBUTES = ['type', 'autocomplete', 'data-yantra-secret'];

/** A running guard. */
export interface FocusGuardHandle {
  /** Removes the guard from future documents and detaches its CDP session. Idempotent. */
  dispose(): Promise<void>;
}

/** Narrow CDP surface the guard needs, so tests can drive install failures. */
export interface FocusGuardDependencies {
  readonly createSession?: (page: PuppeteerPage) => Promise<CDPSession>;
  readonly bindingName?: string;
}

/**
 * The in-page reporter. **Self-contained**: it is shipped to the page by
 * source, so it may reference nothing outside its own body and its arguments.
 * `sensitiveTokens` is embedded into the source as a JSON literal.
 *
 * The classifier mirrors `classifyWithheld` (precedence `password` >
 * `autocomplete` > `secret_marker`); a jsdom parity table and a real-Chrome
 * suite hold the two to one answer.
 */
export function liveViewFocusGuard(
  bindingName: string,
  sensitiveTokens: readonly string[],
  pollMs: number,
): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const installedKey = '__yantraLiveViewFocusGuard';
  const existing = scope[installedKey] as { readonly rebind: (name: string) => void } | undefined;
  if (existing !== undefined) {
    // A later install on the same document reports through its own binding.
    existing.rebind(bindingName);
    return;
  }
  const observed = ['type', 'autocomplete', 'data-yantra-secret'];
  let binding = bindingName;

  const send = (state: 'clear' | 'protected' | 'unknown'): void => {
    const target = scope[binding];
    if (typeof target === 'function') (target as (payload: string) => void)(state);
  };

  const isProtectedControl = (element: Element): boolean => {
    if (element.matches('input[type="password"]')) return true;
    const tokens = (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/u);
    if (tokens.some((token) => sensitiveTokens.includes(token))) return true;
    return element.hasAttribute('data-yantra-secret');
  };

  /** Where focus really is, from the top document down; `unknown` when it cannot be seen. */
  const locate = (): {
    readonly state: 'clear' | 'protected' | 'unknown';
    readonly element: Element | null;
  } => {
    let root: Document;
    try {
      root = (window.top ?? window).document;
    } catch {
      return { state: 'unknown', element: null };
    }
    let element: Element | null = root.activeElement;
    for (let depth = 0; depth < 32 && element !== null; depth += 1) {
      const open = (element as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
      if (open !== null && open.activeElement !== null) {
        element = open.activeElement;
        continue;
      }
      if (element.localName === 'iframe' || element.localName === 'frame') {
        let inner: Document | null;
        try {
          inner = (element as HTMLIFrameElement).contentDocument;
        } catch {
          inner = null;
        }
        if (inner === null) return { state: 'unknown', element: null };
        element = inner.activeElement;
        continue;
      }
      break;
    }
    if (element === null) return { state: 'clear', element: null };
    const owner = element.ownerDocument;
    if (element === owner.body || element === owner.documentElement) {
      return { state: 'clear', element: null };
    }
    // A custom element with focus but no open shadow root may be the host of a
    // closed shadow root whose inner control is focused: cannot be seen.
    if (
      element.localName.includes('-') &&
      (element as Element & { shadowRoot: ShadowRoot | null }).shadowRoot === null &&
      !element.hasAttribute('tabindex') &&
      !element.hasAttribute('contenteditable')
    ) {
      return { state: 'unknown', element };
    }
    return { state: isProtectedControl(element) ? 'protected' : 'clear', element };
  };

  let last: string | null = null;
  let watched: Element | null = null;
  const attributes =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          report();
        })
      : null;

  const report = (): void => {
    const { state, element } = locate();
    if (attributes !== null && element !== watched) {
      attributes.disconnect();
      watched = element;
      if (element !== null) {
        attributes.observe(element, { attributes: true, attributeFilter: observed });
      }
    }
    if (state === last) return;
    last = state;
    send(state);
  };

  // `focusin` sees the new active element; `focusout` fires before focus
  // lands, so it re-reads after the task, letting a following `focusin`
  // report first and avoiding a protected → clear → protected flicker.
  window.addEventListener('focusin', () => report(), true);
  window.addEventListener('focusout', () => setTimeout(report, 0), true);
  // Focus entering a child frame from nothing fires neither of those here,
  // only the window's own blur (not capturing: element blurs do not bubble).
  window.addEventListener('blur', () => setTimeout(report, 0));
  setInterval(report, pollMs);
  scope[installedKey] = {
    rebind: (name: string) => {
      binding = name;
      last = null;
      report();
    },
  };
  report();
}

/** The source the page evaluates: the reporter applied to its arguments. */
export function focusGuardSource(bindingName: string): string {
  return `(${liveViewFocusGuard.toString()})(${JSON.stringify(bindingName)}, ${JSON.stringify(
    SENSITIVE_AUTOCOMPLETE_TOKENS,
  )}, ${FOCUS_GUARD_POLL_MS});`;
}

function parseReport(payload: string): ProtectedFocusState {
  return payload === 'clear' || payload === 'protected' ? payload : 'unknown';
}

/**
 * Installs the guard on the task page. Reports `unknown` at once, then
 * whatever the page reports. If any install step fails it reports `unknown`
 * (fail closed) and rejects with `LiveViewError('FOCUS_GUARD_UNAVAILABLE')`.
 */
export async function installFocusGuard(
  page: PuppeteerPage,
  onFocus: (state: ProtectedFocusState) => void,
  dependencies: FocusGuardDependencies = {},
): Promise<FocusGuardHandle> {
  onFocus('unknown');
  const bindingName =
    dependencies.bindingName ?? `__yantraLiveView_${randomBytes(8).toString('hex')}`;
  let session: CDPSession | null = null;
  let disposed = false;
  let scriptId: string | null = null;
  const onBinding = (event: { readonly name: string; readonly payload: string }): void => {
    if (!disposed && event.name === bindingName) onFocus(parseReport(event.payload));
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const current = session;
    if (current === null) return;
    current.off('Runtime.bindingCalled', onBinding);
    // Best effort by design: the page may already be closed. Each step is
    // attempted; none can affect the run.
    if (scriptId !== null) {
      await current
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })
        .catch(() => undefined);
    }
    await current.send('Runtime.removeBinding', { name: bindingName }).catch(() => undefined);
    await current.detach().catch(() => undefined);
  };

  try {
    session = await (dependencies.createSession ?? ((target) => target.createCDPSession()))(page);
    session.on('Runtime.bindingCalled', onBinding);
    // Scripts added by a session run on new documents only while that
    // session's Page domain is enabled (verified against real Chrome).
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Runtime.addBinding', {
      name: bindingName,
      executionContextName: LIVE_VIEW_WORLD,
    });
    const added = await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: focusGuardSource(bindingName),
      worldName: LIVE_VIEW_WORLD,
      // Also creates the world in, and runs the guard on, the current documents.
      runImmediately: true,
    });
    scriptId = added.identifier;
  } catch (error) {
    onFocus('unknown');
    await dispose();
    throw new LiveViewError(
      'FOCUS_GUARD_UNAVAILABLE',
      'The protected-focus guard could not be installed on the task page; the live view stays hidden.',
      { cause: error },
    );
  }
  return { dispose };
}
