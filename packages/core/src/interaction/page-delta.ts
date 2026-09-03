/**
 * What changed on the page between two frames, said honestly and briefly.
 *
 * After a successful browser action the agent is handed a fresh fifty-element
 * observation and left to work out, by re-reading it, what the action did.
 * "A dialog named `Search results` opened" steers the next move better than
 * eighty re-listed elements do, and it costs a fraction of the bytes.
 *
 * Three properties make this worth having rather than a formatting change:
 *
 * 1. **The delta is true.** Refs are minted by `(role, name, ordinal)`, so
 *    same-named controls that reorder between observations *trade* ref
 *    identities, and the fifty-element model cap can make a perfectly
 *    stationary element disappear from the returned list. A delta computed over
 *    the model-visible list would routinely report appearances and vanishings
 *    that never happened. It is therefore computed over an **uncapped semantic
 *    fingerprint** derived during the scan that was already being taken.
 * 2. **It is free.** The fingerprint is built inside `buildAgentPageSnapshot`
 *    from data the existing in-page scan already produced, before the
 *    model-visible slice. No extra page read, no second DOM walk.
 * 3. **It never over-claims.** Where a bound — a replaced document, a truncated
 *    fingerprint, a degraded scan — prevents a definite statement, the delta
 *    carries a completeness marker instead of a manufactured number.
 *
 * Nothing here reads a hostname, a brand, or a selector table. Every signal is
 * structural: ARIA role, accessible name, group, scope, focus, document epoch,
 * URL.
 */

import type { OverlayIdentity } from '../browser/obstruction.js';
import type { RawInteractable } from '../discovery/interactable-scan.js';

import { diffKeyed } from './differ.js';

/** Most visible candidates a fingerprint counts before it declares itself truncated. */
export const FINGERPRINT_MAX_ENTRIES = 1000;
/** Most dialogs a delta ever names on either side. */
export const DELTA_DIALOG_CAP = 5;
/** Most elements a delta ever names in an appeared/vanished sample. */
export const DELTA_SAMPLE_CAP = 5;
/** Bound on each part of an identity key before it is joined. */
export const IDENTITY_PART_MAX_CHARS = 120;
/** Bound on the serialized delta block, enforced where the block is built. */
export const DELTA_MAX_BYTES = 2048;

/**
 * The separator between identity-key parts.
 *
 * Written as an escape, never as a raw control byte: a literal separator byte
 * in source or in a fixture makes the file read as binary to `grep` and `file`,
 * which has already hidden one document from search in this repository.
 */
const UNIT_SEPARATOR = '\u001F';

/**
 * Private change-detection state for one observed frame.
 *
 * **Never model-visible, never persisted, never logged.** It holds no refs, no
 * handles, no secrets and no resolved values — only page-derived identity keys
 * — and `modelDelta()` at the tool seam is an explicit allow-list projection
 * so nothing here can reach a payload by accident.
 */
export interface ObservationFingerprint {
  /**
   * The document marker stamped on `window`.
   *
   * Equal across two fingerprints **iff** they read the same document. `null`
   * when the page refused the stamp, in which case no replacement can be
   * claimed either way.
   */
  readonly epoch: string | null;
  readonly url: string;
  readonly title: string;
  /** The semantic multiset of visible interactables: identity key → count. */
  readonly entries: ReadonlyMap<string, number>;
  /** Visible candidates counted, **before** {@link FINGERPRINT_MAX_ENTRIES}. */
  readonly entryCount: number;
  /** Whether `entryCount` exceeded {@link FINGERPRINT_MAX_ENTRIES}. */
  readonly truncated: boolean;
  /** Visible dialog/overlay/listbox/menu/grid containers, by identity key. */
  readonly containers: ReadonlyMap<string, OverlayIdentity>;
  /** Identity key of the focused interactable, or `null` when focus is elsewhere. */
  readonly focus: string | null;
  /** Whether the in-page scan degraded, so an empty fingerprint is not read as "no controls". */
  readonly degraded: boolean;
}

/**
 * A fingerprint as the snapshot builder can produce it.
 *
 * The document epoch belongs to the controller — it is the only component that
 * stamps and reads the marker — so the builder returns everything else and the
 * controller completes the record.
 */
export type ScanFingerprint = Omit<ObservationFingerprint, 'epoch'>;

/** Why a delta could not make a definite statement. A closed set carrying no page text. */
export type DeltaIncompleteReason =
  /** The two frames read different documents; their controls are not comparable. */
  | 'document-replaced'
  /** Either frame hit {@link FINGERPRINT_MAX_ENTRIES}. */
  | 'fingerprint-truncated'
  /** Either frame's in-page scan degraded. */
  | 'scan-degraded';

/** Fixed emission order, so two identical bounds never serialize two ways. */
const INCOMPLETE_ORDER: readonly DeltaIncompleteReason[] = [
  'document-replaced',
  'fingerprint-truncated',
  'scan-degraded',
];

/** A bounded, named set of elements that entered or left the page. */
export interface DeltaElementChange {
  /** The **uncapped** multiset difference. Definite whenever it is present at all. */
  readonly count: number;
  /** At most {@link DELTA_SAMPLE_CAP} of them, named. */
  readonly sample?: readonly OverlayIdentity[];
  /** Present when `sample` names fewer than `count`. */
  readonly sample_truncated?: true;
}

/**
 * The bounded difference between two frames.
 *
 * **A `PageDelta` says what changed in the action window — not that the action
 * caused it.** A page that mounts a banner on a timer three hundred
 * milliseconds after a click contributes to the delta exactly as the click's
 * own effects do, and nothing here can tell them apart.
 *
 * **Standing bound:** a container is nameable only when it holds at least one
 * scanned candidate. A delta therefore lists dialogs it *observed opening or
 * closing* and never asserts that no dialog is open. That is a permanent
 * property of the signal rather than a per-call condition, so it is documented
 * here instead of costing every result the bytes to repeat it.
 *
 * Every field is omitted when there is nothing to say, so an action that
 * changed nothing produces a near-empty block.
 */
export interface PageDelta {
  readonly url_changed?: { readonly from: string; readonly to: string };
  readonly title_changed?: { readonly from: string; readonly to: string };
  readonly dialogs_opened?: readonly OverlayIdentity[];
  readonly dialogs_closed?: readonly OverlayIdentity[];
  readonly elements_appeared?: DeltaElementChange;
  readonly elements_vanished?: DeltaElementChange;
  readonly focus_moved?: { readonly from?: OverlayIdentity; readonly to?: OverlayIdentity };
  /**
   * The completeness marker.
   *
   * Present **only** when a bound prevented a definite statement; its absence
   * means the block is definite. Emitted together with {@link PageDelta.incomplete}
   * or not at all.
   */
  readonly complete?: false;
  /** Why the block is incomplete. Present exactly when `complete` is. */
  readonly incomplete?: readonly DeltaIncompleteReason[];
}

/**
 * The semantic identity of one interactable.
 *
 * Deliberately **not** the ref, and deliberately **not** including position or
 * ordinal: an element that moves is the same element, and duplicate identities
 * are handled as multiset counts rather than by ordinal — which is precisely
 * what stops reordered same-named controls from trading identities.
 */
export function identityKey(
  role: string,
  name: string | null,
  group: string | null,
  scope: string,
): string {
  return [role, name ?? '', group ?? '', scope].map(clampPart).join(UNIT_SEPARATOR);
}

/**
 * Build a frame's fingerprint from the scan the caller already took.
 *
 * @param url - The page URL at scan time.
 * @param title - The page title at scan time, already clamped by the builder.
 * @param ordered - The **uncapped** ordered visible candidate list.
 * @param degraded - Whether the in-page scan degraded to no records.
 */
export function fingerprintFromScan(
  url: string,
  title: string,
  ordered: readonly RawInteractable[],
  degraded: boolean,
): ScanFingerprint {
  const entries = new Map<string, number>();
  const containers = new Map<string, OverlayIdentity>();
  let focus: string | null = null;
  let counted = 0;
  for (const entry of ordered) {
    if (counted >= FINGERPRINT_MAX_ENTRIES) break;
    counted += 1;
    const key = identityKey(entry.role, entry.name, entry.group, entry.scope);
    entries.set(key, (entries.get(key) ?? 0) + 1);
    if (entry.focused) focus = key;
    if (entry.container) {
      const identity: OverlayIdentity = {
        role: clampPart(entry.container.role),
        name: clampPart(entry.container.name),
      };
      containers.set(overlayKey(identity), identity);
    }
  }
  return {
    url,
    title,
    entries,
    entryCount: ordered.length,
    truncated: ordered.length > FINGERPRINT_MAX_ENTRIES,
    containers,
    focus,
    degraded,
  };
}

/**
 * Compare two frames and say, within its bounds, what changed between them.
 *
 * Pure and total: every bound it cannot see past becomes a completeness reason,
 * never a throw. Derivation is best-effort on the calling path, and an action
 * that succeeded must never be turned into a tool error by a diagnostic.
 *
 * @param before - The frame the model last saw.
 * @param after - The frame produced by the post-action observation.
 */
export function diffFingerprints(
  before: ObservationFingerprint,
  after: ObservationFingerprint,
): PageDelta {
  const reasons = incompleteReasons(before, after);
  const elementsComparable =
    !reasons.includes('document-replaced') &&
    !reasons.includes('fingerprint-truncated') &&
    !reasons.includes('scan-degraded');
  const focusComparable =
    !reasons.includes('document-replaced') && !reasons.includes('scan-degraded');
  const dialogsComparable = !reasons.includes('scan-degraded');

  const delta: {
    url_changed?: { from: string; to: string };
    title_changed?: { from: string; to: string };
    dialogs_opened?: readonly OverlayIdentity[];
    dialogs_closed?: readonly OverlayIdentity[];
    elements_appeared?: DeltaElementChange;
    elements_vanished?: DeltaElementChange;
    focus_moved?: { from?: OverlayIdentity; to?: OverlayIdentity };
    complete?: false;
    incomplete?: readonly DeltaIncompleteReason[];
  } = {};

  if (before.url !== after.url) delta.url_changed = { from: before.url, to: after.url };
  if (before.title !== after.title) delta.title_changed = { from: before.title, to: after.title };

  if (dialogsComparable) {
    const opened = missingFrom(before.containers, after.containers);
    const closed = missingFrom(after.containers, before.containers);
    if (opened.length > 0) delta.dialogs_opened = opened.slice(0, DELTA_DIALOG_CAP);
    if (closed.length > 0) delta.dialogs_closed = closed.slice(0, DELTA_DIALOG_CAP);
  }

  if (elementsComparable) {
    const diff = diffKeyed(expand(before.entries), expand(after.entries), {
      key: (key) => key,
      sampleCap: DELTA_SAMPLE_CAP,
    });
    const appeared = elementChange(diff.appearedCount, diff.appeared);
    const vanished = elementChange(diff.vanishedCount, diff.vanished);
    if (appeared) delta.elements_appeared = appeared;
    if (vanished) delta.elements_vanished = vanished;
  }

  if (focusComparable && before.focus !== after.focus) {
    const moved: { from?: OverlayIdentity; to?: OverlayIdentity } = {};
    if (before.focus !== null) moved.from = overlayFromKey(before.focus);
    if (after.focus !== null) moved.to = overlayFromKey(after.focus);
    delta.focus_moved = moved;
  }

  if (reasons.length > 0) {
    delta.complete = false;
    delta.incomplete = reasons;
  }
  return boundDelta(delta);
}

/** Serialize a delta, and prove it fits the bound the block is built under. */
export function serializeDelta(delta: PageDelta): string {
  const text = JSON.stringify(delta);
  /* c8 ignore next 5 -- unreachable while `boundDelta` runs on every emitted block. */
  if (Buffer.byteLength(text, 'utf8') > DELTA_MAX_BYTES) {
    throw new Error(
      `PageDelta exceeded DELTA_MAX_BYTES (${DELTA_MAX_BYTES}); the block must be bounded where it is built.`,
    );
  }
  return text;
}

/** UTF-8 byte length of a serialized delta, for the cost telemetry. */
export function deltaBytes(delta: PageDelta): number {
  return Buffer.byteLength(serializeDelta(delta), 'utf8');
}

/**
 * Which bounds prevented a definite statement, decided in one place.
 *
 * One function rather than a condition per field, so the invariant "no definite
 * count may be emitted past a bound that invalidates it" is enforced at a
 * single site and cannot drift field by field.
 */
function incompleteReasons(
  before: ObservationFingerprint,
  after: ObservationFingerprint,
): readonly DeltaIncompleteReason[] {
  const reasons = new Set<DeltaIncompleteReason>();
  // Both `null` means neither frame could be stamped, which is no evidence of
  // replacement — not evidence of replacement.
  if (before.epoch !== after.epoch) reasons.add('document-replaced');
  if (before.truncated || after.truncated) reasons.add('fingerprint-truncated');
  if (before.degraded || after.degraded) reasons.add('scan-degraded');
  return INCOMPLETE_ORDER.filter((reason) => reasons.has(reason));
}

/**
 * Trim a built block until it fits {@link DELTA_MAX_BYTES}.
 *
 * The caps make the block small in every ordinary case; this is the guarantee
 * for the pathological one, where five maximum-length dialog names on each side
 * plus ten maximum-length element names would otherwise overrun. Element
 * samples go first — they are the least steering-relevant names, and dropping
 * one leaves its definite `count` untouched — then the closed-dialog list, then
 * the opened one is trimmed. Counts and completeness reasons are never dropped:
 * they are what the block is for.
 */
function boundDelta(delta: PageDelta): PageDelta {
  let current = delta;
  if (fits(current)) return current;

  current = { ...current, ...stripSample('elements_vanished', current) };
  if (fits(current)) return current;
  current = { ...current, ...stripSample('elements_appeared', current) };
  if (fits(current)) return current;

  for (const side of ['dialogs_closed', 'dialogs_opened'] as const) {
    let list = current[side];
    while (list && list.length > 0) {
      const trimmed = list.slice(0, list.length - 1);
      current = trimmed.length > 0 ? { ...current, [side]: trimmed } : omit(current, side);
      if (fits(current)) return current;
      list = trimmed.length > 0 ? trimmed : undefined;
    }
  }
  /* c8 ignore next 2 -- counts and reasons alone are two orders of magnitude under the bound. */
  return current;
}

function fits(delta: PageDelta): boolean {
  return Buffer.byteLength(JSON.stringify(delta), 'utf8') <= DELTA_MAX_BYTES;
}

/** Drop one element side's names while keeping its definite count. */
function stripSample(
  side: 'elements_appeared' | 'elements_vanished',
  delta: PageDelta,
): Partial<PageDelta> {
  const change = delta[side];
  if (!change?.sample) return {};
  return { [side]: { count: change.count, sample_truncated: true } };
}

function omit<K extends keyof PageDelta>(delta: PageDelta, key: K): PageDelta {
  const { [key]: _dropped, ...rest } = delta;
  return rest;
}

/** Build the appeared/vanished block, or nothing when the side is empty. */
function elementChange(count: number, sample: readonly string[]): DeltaElementChange | null {
  if (count === 0) return null;
  const named = sample.map(overlayFromKey);
  return {
    count,
    ...(named.length > 0 ? { sample: named } : {}),
    ...(named.length < count ? { sample_truncated: true as const } : {}),
  };
}

/** Container identities present in `right` and absent from `left`. */
function missingFrom(
  left: ReadonlyMap<string, OverlayIdentity>,
  right: ReadonlyMap<string, OverlayIdentity>,
): readonly OverlayIdentity[] {
  const result: OverlayIdentity[] = [];
  for (const [key, identity] of right) if (!left.has(key)) result.push(identity);
  return result;
}

/** Flatten a multiset back into the repeated-key list `diffKeyed` compares. */
function expand(entries: ReadonlyMap<string, number>): readonly string[] {
  const flat: string[] = [];
  for (const [key, count] of entries) for (let index = 0; index < count; index += 1) flat.push(key);
  return flat;
}

/** A container's key, built from the same parts and separator as an identity key. */
function overlayKey(identity: OverlayIdentity): string {
  return `${identity.role}${UNIT_SEPARATOR}${identity.name}`;
}

/**
 * Re-hydrate the `{ role, name }` pair an identity key starts with.
 *
 * Role and name are the first two parts of every key this module builds —
 * element and container alike — so one reader serves both.
 */
function overlayFromKey(key: string): OverlayIdentity {
  const parts = key.split(UNIT_SEPARATOR);
  return { role: parts[0] ?? '', name: parts[1] ?? '' };
}

function clampPart(text: string): string {
  return text.length > IDENTITY_PART_MAX_CHARS ? text.slice(0, IDENTITY_PART_MAX_CHARS) : text;
}
