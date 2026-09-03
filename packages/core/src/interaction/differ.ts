/**
 * One keyed differ, parameterized by what "the same thing" means.
 *
 * Two callers in this layer compare two page frames and disagree about
 * identity, and that disagreement is not an accident to be unified away:
 *
 * - `locateEditee` asks which control took the text it just typed. It holds a
 *   live ref for the control it addressed, every consumer of the answer drives
 *   by ref, and a control that kept its ref kept its identity. Ref is exactly
 *   right there.
 * - `diffFingerprints` asks what appeared and vanished on the page. Refs are
 *   minted by `(role, name, ordinal)`, so same-named controls that reorder
 *   between observations **trade** ref identities, and the model-visible cap can
 *   drop a perfectly stationary element from the list. A ref-keyed page diff
 *   would routinely report changes that never happened.
 *
 * So the **API** is generalized and the **identity rule** is not. A caller that
 * wants a different notion of sameness supplies a different `key`; nothing here
 * decides identity on a caller's behalf.
 *
 * The function is pure — no I/O, no clock, no port — which is what makes it
 * directly unit-testable and safe to call on a path that has already mutated
 * the page.
 */

/** The difference between two keyed collections. */
export interface KeyedDiff<T> {
  /** Entries whose key is in surplus on the `after` side, up to `sampleCap`. */
  readonly appeared: readonly T[];
  /** Entries whose key is in surplus on the `before` side, up to `sampleCap`. */
  readonly vanished: readonly T[];
  /** Keys present on both sides whose projection differs, paired in order. */
  readonly changed: readonly { readonly before: T; readonly after: T }[];
  /** Total surplus on the `after` side. **Uncapped**, whatever `sampleCap` is. */
  readonly appearedCount: number;
  /** Total surplus on the `before` side. **Uncapped**. */
  readonly vanishedCount: number;
  /** Whether either sample stopped short of its count. */
  readonly sampleTruncated: boolean;
}

/** How to compare two collections; `key` is the identity policy. */
export interface KeyedDiffOptions<T> {
  /** The identity policy. Entries sharing a key are the same thing. */
  readonly key: (entry: T) => string;
  /** Whether a matched pair differs. Invoked only for keys present on both sides. */
  readonly changed?: (before: T, after: T) => boolean;
  /**
   * Most named entries either sample may carry. Counts are never capped.
   *
   * Defaults to unbounded, because a caller that has not thought about the
   * bound is better served by a complete answer than by a silently short one.
   */
  readonly sampleCap?: number;
}

/**
 * Diff two collections under one identity policy, as multisets.
 *
 * Multiset rather than set: three controls sharing a key against five sharing
 * it is two appearances, not zero. A set-based differ answers zero there, which
 * is the single most common way a page diff under-reports.
 *
 * Unique keys — the ref policy — fall out as the count-1 case with no special
 * branch.
 *
 * @param before - The earlier frame.
 * @param after - The later frame.
 * @param options - Identity policy, optional change predicate, sample bound.
 */
export function diffKeyed<T>(
  before: readonly T[],
  after: readonly T[],
  options: KeyedDiffOptions<T>,
): KeyedDiff<T> {
  const sampleCap = options.sampleCap ?? Number.POSITIVE_INFINITY;
  const beforeBuckets = bucket(before, options.key);
  const afterBuckets = bucket(after, options.key);

  const appeared: T[] = [];
  const vanished: T[] = [];
  const changed: { readonly before: T; readonly after: T }[] = [];
  let appearedCount = 0;
  let vanishedCount = 0;
  let sampleTruncated = false;

  for (const [key, afterEntries] of afterBuckets) {
    const beforeEntries = beforeBuckets.get(key) ?? [];
    const shared = Math.min(beforeEntries.length, afterEntries.length);
    if (afterEntries.length > shared) {
      const surplus = afterEntries.slice(shared);
      appearedCount += surplus.length;
      for (const entry of surplus) {
        if (appeared.length < sampleCap) appeared.push(entry);
        else sampleTruncated = true;
      }
    }
    if (options.changed) {
      for (let index = 0; index < shared; index += 1) {
        const left = beforeEntries[index]!;
        const right = afterEntries[index]!;
        if (options.changed(left, right)) changed.push({ before: left, after: right });
      }
    }
  }

  for (const [key, beforeEntries] of beforeBuckets) {
    const afterEntries = afterBuckets.get(key) ?? [];
    if (beforeEntries.length <= afterEntries.length) continue;
    const surplus = beforeEntries.slice(afterEntries.length);
    vanishedCount += surplus.length;
    for (const entry of surplus) {
      if (vanished.length < sampleCap) vanished.push(entry);
      else sampleTruncated = true;
    }
  }

  return { appeared, vanished, changed, appearedCount, vanishedCount, sampleTruncated };
}

/** Group entries by key, preserving each bucket's original order. */
function bucket<T>(entries: readonly T[], key: (entry: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const entry of entries) {
    const identity = key(entry);
    const existing = buckets.get(identity);
    if (existing) existing.push(entry);
    else buckets.set(identity, [entry]);
  }
  return buckets;
}
