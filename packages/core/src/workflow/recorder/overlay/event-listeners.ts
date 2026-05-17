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

function getRawValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value ?? '';
  }
  return '';
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
  const last = lastFlushTime.get(el) ?? 0;
  const now = performance.now();
  if (now - last < DEBOUNCE_MS) return false;
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
  if (!(target instanceof Element)) return;

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
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
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
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;

  // Force-flush on change (end-of-input)
  lastFlushTime.delete(target);
  handleInput(event);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  const target = event.target;
  if (!(target instanceof Element)) return;
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
let installed = false;
export function installEventListeners(callbacks: EventListenerCallbacks): void {
  if (installed) return;
  installed = true;

  // eslint-disable-next-line @typescript-eslint/unbound-method -- callback is invoked directly; `this` binding is not needed
  onActionCapturedCb = callbacks.onActionCaptured;

  document.addEventListener('click', handleClick, { capture: true });
  document.addEventListener('input', handleInput, { capture: true });
  document.addEventListener('change', handleChange, { capture: true });
  document.addEventListener('keydown', handleKeydown, { capture: true });
}
