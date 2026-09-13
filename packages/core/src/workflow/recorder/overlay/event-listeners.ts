/// <reference lib="dom" />
/**
 * In-page event listeners for the recorder overlay.
 *
 * Captures `click`, `input` (debounced 250ms), `change`, `submit`, and
 * `keydown` (Enter only) events at the document level (capturing phase).
 *
 * For each captured event: builds the ElementDescriptor, grabs the raw value
 * (for fill-type events), runs the locator ranking algorithm in-page, and posts
 * the payload to Node via `window.__yantraRecorderEmit(payload)`.
 *
 * Runs entirely in the browser. No Node.js APIs.
 */

import { rankCandidates } from '../../../locator/ranking.js';

import { buildElementDescriptor } from './descriptor-builder.js';

// ---------------------------------------------------------------------------
// Types mirrored from protocol (no Node imports in browser bundle)
// ---------------------------------------------------------------------------

type InputTypeHint =
  | 'text'
  | 'email'
  | 'password'
  | 'tel'
  | 'number'
  | 'url'
  | 'search'
  | 'textarea'
  | 'other';

interface RawEventPayload {
  kind: 'click' | 'fill' | 'navigate' | 'keydown_enter';
  descriptor: ReturnType<typeof buildElementDescriptor>;
  candidate_chain: { candidate: unknown; score: number; rank_reason: string }[];
  raw_value: string | null;
  value_length: number;
  input_type: InputTypeHint;
  ts: number; // performance.now() + performance.timeOrigin → absolute ms
  url: string;
}

declare global {
  interface Window {
    __yantraRecorderListenerCleanup?: () => void;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getInputType(el: Element): InputTypeHint {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag !== 'input') return 'other';

  const type = (el as HTMLInputElement).type?.toLowerCase();
  const MAP: Record<string, InputTypeHint> = {
    text: 'text',
    email: 'email',
    password: 'password',
    tel: 'tel',
    number: 'number',
    url: 'url',
    search: 'search',
  };
  return MAP[type] ?? 'other';
}

function isElement(value: EventTarget | null): value is Element {
  return value !== null && 'nodeType' in value && value.nodeType === 1;
}

function isTextControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

function getRawValue(el: Element): string {
  return isTextControl(el) ? (el.value ?? '') : '';
}

function nowMs(): number {
  return performance.now() + performance.timeOrigin;
}

function emit(payload: RawEventPayload): void {
  if (typeof window.__yantraRecorderEmit === 'function') {
    try {
      window.__yantraRecorderEmit(JSON.stringify(payload));
    } catch {
      // CDP binding not ready — silently drop. The recording session will
      // catch gaps in the action sequence via the partial-draft mechanism.
    }
  }
}

function buildCandidateChain(el: Element): RawEventPayload['candidate_chain'] {
  try {
    const ranking = rankCandidates(el, { topN: 5 });
    return ranking.candidates.map((c) => ({
      candidate: c.intent,
      score: c.score,
      rank_reason: c.rationale,
    }));
  } catch {
    // Ranking failure is non-fatal — return XPath-only fallback
    const desc = buildElementDescriptor(el);
    return [
      {
        candidate: { kind: 'xpath', expression: desc.xpath_for_debug },
        score: 0.1,
        rank_reason: 'absolute XPath (ranking failed)',
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Debounce per-element for input events
// ---------------------------------------------------------------------------

const lastFlushTime = new WeakMap<Element, number>();
const DEBOUNCE_MS = 250;

function shouldFlushInput(el: Element): boolean {
  const last = lastFlushTime.get(el);
  const now = performance.now();
  if (last !== undefined && now - last < DEBOUNCE_MS) return false;
  lastFlushTime.set(el, now);
  return true;
}

// ---------------------------------------------------------------------------
// Action counter (shared with overlay UI)
// ---------------------------------------------------------------------------

let capturedCount = 0;
let onActionCapturedCb: ((count: number) => void) | null = null;

function recordAction(payload: RawEventPayload): void {
  emit(payload);
  capturedCount++;
  onActionCapturedCb?.(capturedCount);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleClick(event: MouseEvent): void {
  const target = event.target;
  if (!isElement(target)) return;

  // Ignore clicks on the Yantra overlay itself
  if (target.closest('#__yantra-recorder-overlay')) return;

  const descriptor = buildElementDescriptor(target);
  const candidate_chain = buildCandidateChain(target);

  recordAction({
    kind: 'click',
    descriptor,
    candidate_chain,
    raw_value: null,
    value_length: 0,
    input_type: 'other',
    ts: nowMs(),
    url: location.href,
  });
}

function handleInput(event: Event): void {
  const target = event.target;
  if (!isElement(target) || !isTextControl(target)) return;
  if (!shouldFlushInput(target)) return;

  const raw_value = getRawValue(target);
  const input_type = getInputType(target);
  const descriptor = buildElementDescriptor(target);
  const candidate_chain = buildCandidateChain(target);

  recordAction({
    kind: 'fill',
    descriptor,
    candidate_chain,
    raw_value,
    value_length: [...raw_value].length,
    input_type,
    ts: nowMs(),
    url: location.href,
  });
}

function handleChange(event: Event): void {
  const target = event.target;
  if (!isElement(target) || !isTextControl(target)) return;

  // Force-flush on change (end-of-input)
  lastFlushTime.delete(target);
  handleInput(event);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  const target = event.target;
  if (!isElement(target)) return;
  if (target.closest('#__yantra-recorder-overlay')) return;

  const descriptor = buildElementDescriptor(target);
  const candidate_chain = buildCandidateChain(target);

  recordAction({
    kind: 'keydown_enter',
    descriptor,
    candidate_chain,
    raw_value: null,
    value_length: 0,
    input_type: getInputType(target),
    ts: nowMs(),
    url: location.href,
  });
}

// ---------------------------------------------------------------------------
// Public install API
// ---------------------------------------------------------------------------

export interface EventListenerCallbacks {
  onActionCaptured(count: number): void;
}

/**
 * Installs all document-level capturing-phase event listeners.
 * Idempotent — calling twice is safe (the second call is a no-op).
 *
 * @param callbacks - Hooks for the overlay UI to update on each capture
 */
export function installEventListeners(callbacks: EventListenerCallbacks): void {
  // A same-origin initial navigation can preserve Window while replacing
  // Document. Keep the listeners on Window and replace the exact prior set so
  // they follow that transition without creating duplicate captures.
  window.__yantraRecorderListenerCleanup?.();

  // eslint-disable-next-line @typescript-eslint/unbound-method -- callback is invoked directly; `this` binding is not needed
  onActionCapturedCb = callbacks.onActionCaptured;

  window.addEventListener('click', handleClick, { capture: true });
  window.addEventListener('input', handleInput, { capture: true });
  window.addEventListener('change', handleChange, { capture: true });
  window.addEventListener('keydown', handleKeydown, { capture: true });
  window.__yantraRecorderListenerCleanup = () => {
    window.removeEventListener('click', handleClick, { capture: true });
    window.removeEventListener('input', handleInput, { capture: true });
    window.removeEventListener('change', handleChange, { capture: true });
    window.removeEventListener('keydown', handleKeydown, { capture: true });
  };
}
