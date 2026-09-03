import {
  BrowserActionabilityError,
  ElementObstructedError,
  OBSTRUCTION_CAUSE,
  obstructionDetails,
  PROTECTED_ACTION_RE as CORE_PROTECTED_ACTION_RE,
  renderInteractionMessage,
  StaleElementRefError,
  deltaBytes,
  toWireAttemptArtifact,
  type AgentBrowserController,
  type AgentBrowserObservation,
  type AgentInteractable,
  type BrowserActionResult,
  type FillFailure,
  type Obstruction,
  type PageDelta,
  type WidgetPort,
  type WidgetTarget,
} from '@yantra/core';
import type { LocatorCandidate } from '@yantra/protocol';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainFailure } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { resolveFormField } from './form-field-resolve.js';

/** Internal observation cap used for deterministic field resolution. */
export const FILL_RESOLUTION_CAP = 400;

export function browserController(services: RunServices): AgentBrowserController | DomainFailure {
  const controller = services.domain.browser?.controller;
  return (
    controller ?? {
      ok: false,
      errorCode: 'BROWSER_UNAVAILABLE',
      message: renderAgentMessage('tool', 'BROWSER_UNAVAILABLE', 'not-configured'),
      retryable: false,
    }
  );
}

/**
 * Narrows any `T | DomainFailure` union to the failure arm.
 *
 * Generic because tools now return domain values other than a controller from
 * the same union (a resolved form field, a per-field outcome); the check itself
 * is unchanged — only a `DomainFailure` carries `ok: false`.
 */
export function isDomainFailure<T>(value: T | DomainFailure): value is DomainFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    (value as { readonly ok: unknown }).ok === false
  );
}

/**
 * Map a controller actionability failure onto the provider-neutral tool result.
 *
 * `retryable` is deliberately `true` for every obstruction kind, and that is a
 * different question from `classifyFailure`'s internal disposition. The flag
 * answers "could a *corrected* retry succeed?" — after dismissing one of the
 * offered refs, it genuinely can. The disposition answers "is another *identical*
 * attempt worth making right now?" and is kind-driven: transient for a busy
 * indicator, terminal for everything else once the single clearance has run. The
 * two must not be collapsed into one flag.
 */
export function browserFailure(error: unknown, services?: RunServices): DomainFailure {
  if (error instanceof ElementObstructedError) {
    // Sanitize FIRST, then render: the model-visible sentence and the recorded
    // `details` are built from the same sanitized values, so they cannot
    // disagree and neither can carry raw page text. `kind`, `clearance_*`,
    // `point` and the candidate booleans are fixed enums, numbers and booleans
    // by construction and are logged verbatim.
    const sanitized = sanitizeObstruction(error.obstruction, services);
    const details = obstructionDetails(sanitized);
    const rendered = renderInteractionMessage(
      'actionability',
      'ELEMENT_OBSTRUCTED',
      OBSTRUCTION_CAUSE[sanitized.kind],
      details,
    );
    return {
      ok: false,
      errorCode: 'ELEMENT_OBSTRUCTED',
      message: rendered.message,
      retryable: true,
      details,
    };
  }
  if (error instanceof StaleElementRefError || error instanceof BrowserActionabilityError) {
    return { ok: false, errorCode: error.code, message: error.message, retryable: true };
  }
  if (error instanceof Error && error.message.includes('browser_navigate')) {
    return {
      ok: false,
      errorCode: 'BROWSER_NOT_STARTED',
      message: renderAgentMessage('tool', 'BROWSER_NOT_STARTED', 'not-started', {
        message: error.message,
      }),
      retryable: true,
    };
  }
  throw error;
}

/**
 * Preserve a core fill failure verbatim at the provider-neutral tool seam.
 *
 * The next step rides in the message, not only in `details`. A model that sees
 * a bare typed code tends to abandon the tool and operate the widget by hand
 * with browser_click, which is the behaviour these tools exist to replace, so
 * the one actionable sentence has to be somewhere it cannot miss. The hint is
 * now composed from the observed state rather than looked up by code, so two
 * failures sharing a code but not a cause no longer read identically.
 *
 * `observed`, `offered`, and `attempted` ride along in `details` and are the
 * three facts a caller needs to avoid repeating work: what the control holds
 * now, what the widget will actually accept, and what recovery already ran.
 */
export function mapFillFailure(failure: FillFailure): DomainFailure {
  const hint = typeof failure.details.hint === 'string' ? failure.details.hint : null;
  return {
    ok: false,
    errorCode: failure.errorCode,
    message: hint ? `${failure.message} ${hint}` : failure.message,
    retryable: failure.retryable,
    details:
      failure.details.attempted === undefined
        ? failure.details
        : {
            ...failure.details,
            attempted: toWireAttemptArtifact(failure.details.attempted),
          },
  };
}

/** Resolve a visible field name or current eNN ref from a fresh observation. */
export async function resolveFillTarget(
  field: string,
  controller: AgentBrowserController,
  preferred?: WidgetTarget,
): Promise<WidgetTarget | DomainFailure> {
  const resolved = await resolveFillField(field, controller, preferred);
  return isDomainFailure(resolved) ? resolved : resolved.target;
}

/** A resolved fill target together with the observation it came from. */
export interface ResolvedFillField {
  readonly target: WidgetTarget;
  /**
   * The observation the target was resolved from.
   *
   * Kept because it is the before-picture the fill engine's editee resolution
   * needs. Taking it here and handing it on costs nothing; letting the engine
   * take its own would charge every fill an extra page read for a question most
   * fills never have to ask.
   */
  readonly observation: AgentBrowserObservation;
}

/** Resolve a fill target and keep the observation that produced it. */
export async function resolveFillField(
  field: string,
  controller: AgentBrowserController,
  preferred?: WidgetTarget,
): Promise<ResolvedFillField | DomainFailure> {
  const observation = await controller.observe({
    cap: FILL_RESOLUTION_CAP,
    trackDigest: false,
  });
  const resolved = resolveFormField(
    field,
    observation,
    preferred ? { preferred, allowEquivalentCopies: true } : {},
  );
  return isDomainFailure(resolved) ? resolved : { target: toWidgetTarget(resolved), observation };
}

function toWidgetTarget(entry: AgentInteractable): WidgetTarget {
  return {
    ref: entry.ref,
    role: entry.role,
    name: entry.name,
    group: entry.group ?? null,
    value: entry.value ?? null,
  };
}

/**
 * Collects what the page raised while a fill was driving it.
 *
 * A plain collector, deliberately: **no retry, budget, or ordering semantics of
 * its own**, so the recovery runner can later wrap it for action accounting
 * without unpicking anything here.
 *
 * It exists because `WidgetPort.click/fill/clear/type` return `Promise<unknown>`
 * and every caller discarded the `BrowserActionResult` the controller built. A
 * popup, a JS dialog, or a landing URL produced **by a fill** was therefore
 * either dropped or surfaced on whatever tool ran next, and `browser_navigate`
 * later refused the URL a fill had navigated to as `URL_NOT_FROM_EVIDENCE`.
 */
export interface ActionMetadataSink {
  /** Absorb one port action's result. Anything unrecognizable is ignored. */
  record(result: unknown): void;
  /** Everything absorbed so far, merged into one result. */
  drain(): BrowserActionResult;
}

/** Build a fresh collector for one top-level fill call. */
export function actionMetadataSink(): ActionMetadataSink {
  let merged: BrowserActionResult = { url: '', title: '' };
  return {
    record(result: unknown): void {
      if (typeof result !== 'object' || result === null) return;
      const entry = result as Partial<BrowserActionResult>;
      merged = mergeActionMetadata(merged, entry);
    },
    drain: () => merged,
  };
}

/**
 * Merge one action's metadata into the accumulation.
 *
 * `url`/`title` take the latest the page reported, because the last action is
 * where the fill left the run standing. The intercepted popup and dialog take
 * the **first**, because each is drained once from its queue and the first one
 * is the one this fill caused. `popup_followable` takes the latest, because it
 * reflects a tab the controller is *still* holding rather than a past event.
 * Overlay dismissals are counted, since each is a separate thing the engine did
 * on the user's behalf.
 */
export function mergeActionMetadata(
  into: BrowserActionResult,
  entry: Partial<BrowserActionResult>,
): BrowserActionResult {
  return {
    url: entry.url && entry.url.length > 0 ? entry.url : into.url,
    title: entry.title && entry.title.length > 0 ? entry.title : into.title,
    ...(into.popup_intercepted !== undefined
      ? { popup_intercepted: into.popup_intercepted }
      : entry.popup_intercepted !== undefined
        ? { popup_intercepted: entry.popup_intercepted }
        : {}),
    ...(into.dialog_intercepted !== undefined
      ? { dialog_intercepted: into.dialog_intercepted }
      : entry.dialog_intercepted !== undefined
        ? { dialog_intercepted: entry.dialog_intercepted }
        : {}),
    ...(entry.popup_followable !== undefined
      ? { popup_followable: entry.popup_followable }
      : into.popup_followable !== undefined
        ? { popup_followable: into.popup_followable }
        : {}),
    ...(entry.switched_to_new_tab !== undefined
      ? { switched_to_new_tab: entry.switched_to_new_tab }
      : into.switched_to_new_tab !== undefined
        ? { switched_to_new_tab: into.switched_to_new_tab }
        : {}),
    ...((into.overlays_dismissed ?? 0) + (entry.overlays_dismissed ?? 0) > 0
      ? { overlays_dismissed: (into.overlays_dismissed ?? 0) + (entry.overlays_dismissed ?? 0) }
      : {}),
  };
}

/**
 * Thin core port adapter; action healing belongs to the controller.
 *
 * @param sink - Optional collector for what each action produced. Omitted by
 *   callers that do not attribute page-raised events — the deterministic paths
 *   and the widget probes — so nothing changes for them.
 */
export function browserWidgetPort(
  controller: AgentBrowserController,
  now: () => number,
  sink?: ActionMetadataSink,
): WidgetPort {
  const collected = async <T>(action: Promise<T>): Promise<T> => {
    const result = await action;
    sink?.record(result);
    return result;
  };
  return {
    observe: (options) => controller.observe(options),
    click: (ref) => collected(controller.click(ref)),
    fill: (ref, value) => collected(controller.fill(ref, value)),
    clear: (ref) => collected(controller.clear(ref)),
    type: (ref, text, options) => collected(controller.type(ref, text, options ?? {})),
    evaluateOn: (ref, fn, ...args) => controller.evaluateOn(ref, fn, ...args),
    evaluate: (fn, ...args) => controller.evaluate(fn, ...args),
    press: (key) => controller.press(key),
    scrollContainer: (container, step) => controller.scrollContainer(container, step),
    now,
  };
}

/**
 * Everything a fill produced, drained once at the end of the tool call.
 *
 * The controller drain catches anything the page raised *after* the fill's last
 * port action — a popup opened on a timer, a dialog raised by a blur handler —
 * which would otherwise land on whatever tool runs next. It takes no page read.
 */
export function drainFillMetadata(
  controller: AgentBrowserController,
  sink: ActionMetadataSink,
): BrowserActionResult {
  const collected = sink.drain();
  if (typeof controller.takeActionMetadata !== 'function') return collected;
  try {
    return mergeActionMetadata(collected, controller.takeActionMetadata());
  } catch {
    return collected;
  }
}

/** The model-visible half of a fill's action metadata; `popup_followable` never ships. */
export function modelActionMetadata(
  metadata: BrowserActionResult,
): Record<string, string | number> {
  return {
    ...(metadata.popup_intercepted !== undefined
      ? { popup_intercepted: metadata.popup_intercepted }
      : {}),
    ...(metadata.dialog_intercepted !== undefined
      ? { dialog_intercepted: metadata.dialog_intercepted }
      : {}),
    ...(metadata.switched_to_new_tab !== undefined
      ? { switched_to_new_tab: metadata.switched_to_new_tab }
      : {}),
    ...(metadata.overlays_dismissed !== undefined
      ? { overlays_dismissed: metadata.overlays_dismissed }
      : {}),
  };
}

/**
 * Re-exported from `@yantra/core` — the same object, not a copy.
 *
 * Clearance candidate filtering runs inside `packages/core`, which may never
 * import `@yantra/agent`, so the constant lives there. Injecting the predicate
 * from this layer instead would make a safety filter omittable by a caller,
 * which is a bug class rather than a layering preference.
 */
export const PROTECTED_ACTION_RE = CORE_PROTECTED_ACTION_RE;

/**
 * Pass every page-derived name in an obstruction through the run's sanitizer.
 *
 * Failure messages otherwise get only the middleware's user-input masking; an
 * overlay's accessible name is ordinary page content and must clear the same
 * profile sanitizer as any other observation field before it reaches the model
 * or `tool-calls.jsonl`. User-supplied values are masked back to their
 * placeholders first, the way every other model-visible payload is bounded.
 */
function sanitizeObstruction(obstruction: Obstruction, services?: RunServices): Obstruction {
  if (!services) return obstruction;
  const host = services.domain.browser?.controller.host();
  const clean = (value: string): string =>
    services.sanitizer.sanitize(services.userInput?.mask(value) ?? value, 'public', host).text;
  return {
    ...obstruction,
    identity: { ...obstruction.identity, name: clean(obstruction.identity.name) },
    candidates: obstruction.candidates.map((candidate) => ({
      ...candidate,
      name: clean(candidate.name),
    })),
  };
}

/**
 * Derives the durable locator chain for a ref without ever failing the action.
 *
 * The chain is recorded so a promoted workflow can find the element again; it
 * is not part of doing what the user asked. A controller that cannot supply one
 * — an older or stubbed implementation, a page mid-navigation — must degrade to
 * the caller's fallback, never turn a successful click into a tool error.
 *
 * @param controller - The run's browser controller.
 * @param ref - The opaque ref about to be acted on.
 * @returns The ranked chain, or `[]` when it cannot be derived.
 */
export async function safeLocatorFor(
  controller: AgentBrowserController,
  ref: string,
): Promise<LocatorCandidate[]> {
  if (typeof controller.locatorFor !== 'function') return [];
  try {
    return await controller.locatorFor(ref);
  } catch {
    return [];
  }
}

/**
 * Attest what a completed browser action put in front of the run.
 *
 * Every action result carries URLs the *page itself* produced, and provenance
 * exists to separate those from URLs a model assembled. Two of them:
 *
 * - **Where the action landed.** A click that navigates, or a navigation the
 *   site redirected, arrives somewhere the run reached organically. Returning
 *   to it later must not be refused as a guess.
 * - **An intercepted popup's target.** The single-page policy closes popups and
 *   reports the URL precisely so a later explicit navigation can re-enter it
 *   through URL and ethics policy — that is the documented contract.
 *
 * Only `browser_navigate` used to do this, and popups are opened by *clicks*.
 * So a search button with `target=_blank` produced a `popup_intercepted` URL
 * the agent was then forbidden to visit: runs
 * `20260811T023421Z-do-83684cb3` (Priceline) and
 * `20260811T025845Z-do-963e62f1` (KAYAK) each burned their remaining budget
 * alternating between clicking Search and being refused
 * `URL_NOT_FROM_EVIDENCE` for the URL the tool had just handed them, and both
 * published results for the wrong dates. Recording lives here, at the seam
 * every action result passes through, so no future tool can forget it.
 */
export function recordActionProvenance(
  services: RunServices,
  result: {
    readonly url: string;
    readonly popup_intercepted?: string | undefined;
    readonly popup_followable?: string | undefined;
  },
): void {
  services.urlProvenance.record(result.url);
  if (result.popup_intercepted !== undefined) {
    services.urlProvenance.record(result.popup_intercepted);
  }
  // A held-open popup reports its *live* address, which is where it settled
  // after any redirect the site ran inside it. That is the URL the follow check
  // below re-validates, so it is the URL that has to be attested.
  if (result.popup_followable !== undefined) {
    services.urlProvenance.record(result.popup_followable);
  }
}

/**
 * Continue in a tab the site opened for itself, when policy allows it.
 *
 * Handing back a URL is not the same as handing back the page. A search that
 * submits into a new tab leaves its results *in that tab* — behind a session
 * token, a POST, or plain server-side state — so the address on its own
 * reproduces an empty listings page as often as not, and the opener is
 * frequently sent somewhere else entirely in the same gesture (run
 * `20260812T025402Z-do-7af96d55`: KAYAK opened its results and redirected the
 * page behind them to booking.com, so the URL the tool returned loaded the
 * partner site instead). Following the tab keeps the page the click actually
 * produced.
 *
 * This is the last check, not the first: the controller only offers a popup it
 * opened on the acting page's own site, and the caller reaches here only after
 * the action itself is complete. The URL still passes exactly what
 * `browser_navigate` would apply to it — provenance (recorded from this very
 * result), host/URL policy, and the ethics gate — because arriving somewhere
 * new is a navigation however the site phrased it. Anything refused simply
 * leaves `popup_intercepted` in place for the model to navigate explicitly.
 *
 * @returns The result to report: the adopted tab's, or the original unchanged.
 */
export async function followSiteOpenedTab(
  services: RunServices,
  controller: AgentBrowserController,
  result: BrowserActionResult,
): Promise<BrowserActionResult> {
  const candidate = result.popup_followable;
  if (candidate === undefined) return result;
  const deps = services.domain.browser;
  if (!deps) return result;
  if (!services.urlProvenance.has(candidate)) return result;
  const allowed = services.urlPolicy.check(candidate);
  if (!allowed.isOk) return result;
  try {
    await deps.ethics.check(allowed.value.url, 'navigate', {
      taskId: services.runId,
      runId: services.runId,
      stepId: 'browser_follow_new_tab',
    });
  } catch {
    // Refused, rate-limited, or unreachable: the tab stays unadopted and the
    // model still has `popup_intercepted` to decide about explicitly.
    return result;
  }
  const adopted = await controller.adoptPopup();
  if (!adopted) return result;
  recordActionProvenance(services, adopted);
  return adopted;
}

/** What a post-action read produced: the fresh page, and what changed to reach it. */
export interface PostActionRead {
  readonly observation?: AgentBrowserObservation;
  readonly delta?: PageDelta;
}

/**
 * Best-effort fresh read after a successful action, plus the delta to it.
 *
 * The contract is unchanged and deliberately so: a failed read degrades to no
 * observation **and no delta** rather than converting a successful click into a
 * tool error. The delta is a diagnostic, and a diagnostic may never be the
 * thing that fails an action that already happened.
 */
export async function observeAfterAction(
  controller: AgentBrowserController,
): Promise<PostActionRead> {
  try {
    const observation = await controller.observe();
    const delta = deltaAfterAction(controller);
    return delta === null ? { observation } : { observation, delta };
  } catch {
    return {};
  }
}

/**
 * The delta for a caller that has already taken its own post-action observation.
 *
 * Takes no page read of its own — both fingerprints were derived inside
 * observations the caller had already paid for. Degrades to `null` for a
 * controller that cannot supply one (an older or stubbed implementation, a page
 * mid-navigation), for the same reason `safeLocatorFor` does: a diagnostic must
 * never turn a successful action into a tool error.
 *
 * @returns The delta, or `null` when there was no baseline to diff against.
 */
export function deltaAfterAction(controller: AgentBrowserController): PageDelta | null {
  if (typeof controller.deltaSinceBaseline !== 'function') return null;
  try {
    return controller.deltaSinceBaseline();
  } catch {
    return null;
  }
}

/**
 * The non-model-visible record of what the delta cost, and why it is absent.
 *
 * Rides the existing `details` payload, which already reaches `tool-calls.jsonl`
 * as `output_sanitized`. No protocol change: `ToolAuditEntry` is `.strict()`
 * and gains no field.
 */
export function deltaDetails(
  observation: AgentBrowserObservation | undefined,
  delta: PageDelta | undefined,
): Record<string, unknown> {
  if (!observation) return {};
  const observationBytes = Buffer.byteLength(JSON.stringify(modelObservation(observation)), 'utf8');
  if (!delta) {
    // The ordinary state of the first navigation in a run: the model has seen
    // no frame, so there was nothing to diff. Recorded rather than left blank,
    // so an absent block reads as "no baseline" and never as "nothing changed".
    return { delta_omitted: 'no-baseline', observation_bytes: observationBytes };
  }
  return {
    delta_bytes: deltaBytes(delta),
    observation_bytes: observationBytes,
  };
}

/**
 * Project a delta onto the model-visible payload, by explicit allow-list.
 *
 * The list is the point rather than a formality: the private
 * `ObservationFingerprint` the delta was computed from holds identity keys for
 * every control on the page, and rebuilding the block field by field is what
 * makes it structurally impossible for one to reach a payload. A boundary test
 * asserts the output carries no fingerprint field and no identity map.
 */
export function modelDelta(delta: PageDelta): PageDelta {
  return {
    ...(delta.url_changed ? { url_changed: delta.url_changed } : {}),
    ...(delta.title_changed ? { title_changed: delta.title_changed } : {}),
    ...(delta.dialogs_opened ? { dialogs_opened: delta.dialogs_opened } : {}),
    ...(delta.dialogs_closed ? { dialogs_closed: delta.dialogs_closed } : {}),
    ...(delta.elements_appeared ? { elements_appeared: delta.elements_appeared } : {}),
    ...(delta.elements_vanished ? { elements_vanished: delta.elements_vanished } : {}),
    ...(delta.focus_moved ? { focus_moved: delta.focus_moved } : {}),
    ...(delta.complete === false ? { complete: false as const } : {}),
    ...(delta.incomplete ? { incomplete: delta.incomplete } : {}),
  };
}

/** Convert the controller's internal camelCase digest state to the tool shape. */
export function modelObservation(observation: AgentBrowserObservation): {
  readonly url: string;
  readonly title: string;
  readonly digest?: string;
  readonly digest_unchanged?: true;
  readonly interactables: AgentBrowserObservation['interactables'];
} {
  const model: {
    url: string;
    title: string;
    digest?: string;
    digest_unchanged?: true;
    interactables: AgentBrowserObservation['interactables'];
  } = {
    url: observation.url,
    title: observation.title,
    interactables: observation.interactables,
  };
  if (observation.digestUnchanged) model.digest_unchanged = true;
  else if (observation.digest.length > 0) model.digest = observation.digest;
  return model;
}
