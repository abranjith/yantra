/**
 * ModelSuppliedValues — the run's record of what the model already knows.
 *
 * The payload strippers exist to stop UNTRUSTED third-party data from reaching
 * the model. A value the model itself typed into a tool call is not that: it is
 * already in the context window, so replacing it with `[redacted-phone]` in the
 * result of that call (or in any later observation) protects nothing and costs
 * the agent its feedback loop.
 *
 * That was a real failure, not a hypothetical one. An agent navigated to
 * `?tracknumbers=874426145172` and the navigation result came back as
 * `?tracknumbers=[redacted-phone]`. Unable to confirm the value had survived,
 * it retried, hunted for workarounds, and finally published the false claim
 * that the runtime had failed to substitute the value.
 *
 * This registry is the third piece of the redaction contract, alongside the
 * `UserInputVault` (the user's values, reversible) and the strippers (page
 * content, irreversible):
 *
 * - The user's values → `{{user:...}}` tokens, resolved at the tool boundary.
 * - The model's own values → preserved verbatim, everywhere, for the whole run.
 * - Everything else → `[redacted-*]`, gone.
 *
 * Run scope (not call scope) is deliberate. Once the model has typed a tracking
 * number into one call, redacting it from a page it observes three calls later
 * hides nothing it does not already have — and that page is exactly where the
 * answer lives.
 *
 * Security note: entries only ever come from tool-call parameters the model
 * authored, BEFORE placeholder resolution. A value the model never saw can
 * therefore never enter this registry, so preservation cannot widen what the
 * model learns.
 */

/** Below this length a match is too common to preserve safely or usefully. */
const MIN_VALUE_LENGTH = 4;

/**
 * Minimum length for a token lifted OUT of a larger string. Higher than the
 * whole-value minimum: a short fragment (`4111` out of a card number) could
 * otherwise shield part of an unrelated number and stop a redactor matching it.
 */
const MIN_TOKEN_LENGTH = 6;

/** Values longer than this are page-sized blobs, not identifiers worth pinning. */
const MAX_VALUE_LENGTH = 256;

/** Bound on retained entries so a long run cannot grow the preserve list without limit. */
const MAX_ENTRIES = 256;

/** Token separators: everything that cannot be part of an id or an address. */
const TOKEN_SPLIT_RE = /[^A-Za-z0-9@._+-]+/;

/** Punctuation that is part of the separator, not of the token itself. */
const TOKEN_TRIM_RE = /^[._+-]+|[._+-]+$/g;

/**
 * Run-scoped set of strings the model supplied in tool calls. One instance per
 * agentic run; never shared across runs.
 */
export class ModelSuppliedValues {
  private readonly values = new Set<string>();

  /** Number of retained values. */
  public get size(): number {
    return this.values.size;
  }

  /**
   * Record every string leaf of a model-authored tool-call parameter value.
   * Structure is walked; non-string leaves are ignored.
   *
   * @param params The raw (pre-resolution) tool parameters as the model sent them.
   */
  public record(params: unknown): void {
    if (typeof params === 'string') {
      this.add(params);
      return;
    }
    if (Array.isArray(params)) {
      for (const entry of params) this.record(entry);
      return;
    }
    if (params !== null && typeof params === 'object') {
      for (const entry of Object.values(params)) this.record(entry);
    }
  }

  /**
   * The retained values, longest first so a shorter value nested inside a
   * longer one cannot claim the longer one's text during protection.
   */
  public list(): readonly string[] {
    return [...this.values].sort((left, right) => right.length - left.length);
  }

  private add(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length > MAX_VALUE_LENGTH) return;
    this.retain(trimmed, MIN_VALUE_LENGTH);
    // Also retain the identifier-shaped tokens INSIDE the string. The model
    // rarely hands a tool the bare value: it passes a whole URL
    // (`...?tracknumbers=874426145172`), and the site then answers from a
    // different URL carrying the same number. Whole-string matching alone
    // would miss that, which is precisely the case that failed.
    for (const raw of trimmed.split(TOKEN_SPLIT_RE)) {
      const token = raw.replace(TOKEN_TRIM_RE, '');
      // Only tokens a redactor could plausibly consume are worth retaining:
      // something with a digit (ids, numbers) or an address. Bare words never
      // need protection and would only dilute the list.
      if (!/\d/.test(token) && !token.includes('@')) continue;
      this.retain(token, MIN_TOKEN_LENGTH);
    }
  }

  private retain(value: string, minLength: number): void {
    if (value.length < minLength) return;
    if (this.values.has(value) || this.values.size >= MAX_ENTRIES) return;
    this.values.add(value);
  }
}
