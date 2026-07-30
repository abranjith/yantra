/**
 * Replay evidence ledger (FEAT-FP-001, TASK-001).
 *
 * Deterministic replay produces a synthesized Brief, and a Brief without
 * citable sources is worthless — but `extract` historically kept only the
 * scraped value and discarded *where it came from*. This ledger is the missing
 * provenance record: every successful extract appends one
 * {@link ReplayEvidenceEntry} describing the page that was read, and the
 * Synthesize stage turns those entries into the Brief's numbered sources.
 *
 * ## Why it is bounded
 *
 * A replay loop can extract thousands of times (a `loop` over a paginated
 * table extracts once per page). An unbounded ledger would grow with the run
 * and, worse, would be assembled into an LLM prompt — blowing both process
 * memory and the model's context budget. Two caps therefore hold at all times:
 * {@link MAX_EVIDENCE_ENTRIES} entries and {@link MAX_EVIDENCE_TEXT_BYTES} of
 * total text. Overflow drops **oldest-first** (the most recent reads are the
 * ones a Brief is about) and bumps {@link ReplayEvidenceLedger.overflowCount},
 * which the Synthesize stage surfaces as an honest `BriefNotice` rather than
 * silently thinning the evidence.
 *
 * ## Why the clock is injected
 *
 * `fetchedAt` comes from the caller's `ctx.clock.now()`, never `Date.now()`.
 * Replay artifacts (including `brief.json`, which embeds `fetched_at` per
 * source) must be byte-for-byte reproducible under a fake clock; a wall-time
 * read here would make every golden comparison flap.
 */

/** One recorded source read — the provenance of a single successful extract. */
export interface ReplayEvidenceEntry {
  /** `ctx.page.url()` at extract time. */
  readonly url: string;
  /** Post-redirect URL when observed, else null. */
  readonly finalUrl: string | null;
  /** Host derived from `finalUrl ?? url`. */
  readonly host: string;
  /** `document.title`, or null when unavailable. */
  readonly title: string | null;
  /** The extracted text — readable output, or serialized rows for a table. */
  readonly text: string;
  /** ISO-8601 timestamp taken from the run's injected clock, never wall time. */
  readonly fetchedAt: string;
  /** The originating extract step id, for audit join against `events.jsonl`. */
  readonly stepId: string;
}

/**
 * Maximum retained entries. A replay loop extracting once per page would
 * otherwise grow the ledger without bound; 32 sources is already far more than
 * any Brief cites.
 */
export const MAX_EVIDENCE_ENTRIES = 32;

/**
 * Maximum retained text across all entries (UTF-8 bytes). Bounds the eventual
 * prompt payload as well as process memory.
 */
export const MAX_EVIDENCE_TEXT_BYTES = 256 * 1024;

/**
 * Append-only, bounded record of the sources a replay read.
 *
 * Appends never throw for capacity reasons — the ledger self-trims. Callers
 * (see `step-handlers/extract.ts`) still treat appending as best-effort: a
 * ledger problem must never fail the extract step that produced real data.
 *
 * @example
 * const ledger = new ReplayEvidenceLedger();
 * ledger.append({
 *   url: 'https://example.com/a',
 *   finalUrl: null,
 *   host: 'example.com',
 *   title: 'A',
 *   text: 'body text',
 *   fetchedAt: new Date(ctx.clock.now()).toISOString(),
 *   stepId: 's3',
 * });
 * ledger.entries(); // → [entry]
 */
export class ReplayEvidenceLedger {
  private readonly items: ReplayEvidenceEntry[] = [];
  private textBytes = 0;
  private overflow = 0;

  public constructor(
    private readonly maxEntries: number = MAX_EVIDENCE_ENTRIES,
    private readonly maxTextBytes: number = MAX_EVIDENCE_TEXT_BYTES,
  ) {}

  /**
   * Appends one recorded read, trimming oldest-first to stay within both caps.
   *
   * An entry whose own text exceeds the byte budget is truncated rather than
   * rejected — losing the tail of one long page is strictly better than losing
   * the source entirely. Both trimming and truncation count as overflow.
   *
   * @param entry - The read to record. Stored as given, except for an
   *   over-budget `text`, which is truncated to {@link MAX_EVIDENCE_TEXT_BYTES}.
   */
  public append(entry: ReplayEvidenceEntry): void {
    const text = truncateUtf8(entry.text, this.maxTextBytes);
    if (text.length !== entry.text.length) {
      this.overflow += 1;
    }

    const stored: ReplayEvidenceEntry = text === entry.text ? entry : { ...entry, text };
    this.items.push(stored);
    this.textBytes += byteLength(stored.text);

    while (this.items.length > this.maxEntries || this.textBytes > this.maxTextBytes) {
      const dropped = this.items.shift();
      if (dropped === undefined) break;
      this.textBytes -= byteLength(dropped.text);
      this.overflow += 1;
    }
  }

  /** The retained entries, oldest first. */
  public entries(): readonly ReplayEvidenceEntry[] {
    return this.items;
  }

  /**
   * How much evidence was lost to the caps — dropped entries plus truncated
   * bodies. The Synthesize stage reports a non-zero count as a `BriefNotice`.
   */
  public overflowCount(): number {
    return this.overflow;
  }
}

/** UTF-8 byte length of a string. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes, never leaving a partial
 * code unit (a split multi-byte sequence would otherwise decode to U+FFFD and
 * could push the result back over budget).
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;

  let sliced = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  while (sliced.length > 0 && byteLength(sliced) > maxBytes) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}
