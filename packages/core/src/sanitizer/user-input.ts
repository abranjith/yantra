/**
 * UserInputVault — reversible redaction for the user's OWN input (FEAT fix:
 * redacted-values-break-tools).
 *
 * The payload sanitizer (`sanitize()`) irreversibly replaces sensitive shapes
 * with constant markers such as `[redacted-email]`. That is correct for
 * untrusted page content, but it is wrong for the user's own goal/profile
 * context: the agent must be able to USE those values (fill a form, open a
 * signed URL, search) without ever SEEING them. The vault solves this with
 * indexed, resolvable placeholders:
 *
 * - `redact(text)` replaces each detected sensitive value with a placeholder
 *   like `{{user:email:1}}` and remembers the mapping. Identical values map to
 *   the same placeholder, so the model can disambiguate and reuse them.
 * - `resolve(text)` restores the original values — called ONLY at the tool
 *   execution boundary (the same posture as opaque secret references: values
 *   materialize at execution, never in model-visible text).
 * - `mask(text)` replaces any occurrence of a stored original value with its
 *   placeholder — applied to model-visible tool output so a page that echoes a
 *   filled value shows the model the same stable placeholder token.
 *
 * Unlike the payload sanitizer, `redact` never HTML-parses the text (goals are
 * plain text; the cheerio round-trip mangles `&`/`<`) and never strips URL
 * query parameters — auth-shaped parameter values are tokenized instead, so a
 * user-pasted signed URL survives redaction and still navigates correctly
 * after resolution.
 *
 * The vault holds raw values in memory for one run only; it must never be
 * serialized into run artifacts or prompts.
 */

import { isLuhnValid, SENSITIVE_VALUE_PATTERNS } from './strippers.js';

/** Classification tags rendered into placeholder tokens. */
export type UserInputValueTag =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit_card'
  | 'api_key'
  | 'auth_param';

/** Matches any vault placeholder token, e.g. `{{user:email:1}}`. */
const PLACEHOLDER_RE = /\{\{user:[a-z_]+:\d+\}\}/g;

/** Auth-shaped query parameter assignments inside URL-ish text (string-level). */
const AUTH_PARAM_ASSIGNMENT_RE = new RegExp(
  `([?&](?:${SENSITIVE_VALUE_PATTERNS.authQueryParam.source})=)([^&#\\s"'<>]+)`,
  'gi',
);

/** True when the string is (or contains) a vault placeholder token shape. */
export function containsUserInputPlaceholder(text: string): boolean {
  return new RegExp(PLACEHOLDER_RE.source).test(text);
}

/**
 * Run-scoped store of user-provided sensitive values behind resolvable
 * placeholders. One instance per agentic run; never shared across runs.
 */
export class UserInputVault {
  private readonly valueByPlaceholder = new Map<string, string>();
  private readonly placeholderByValue = new Map<string, string>();
  private readonly countersByTag = new Map<UserInputValueTag, number>();

  /** Number of distinct values currently stored. */
  public get size(): number {
    return this.valueByPlaceholder.size;
  }

  /**
   * Replace sensitive values in the user's own text with indexed placeholders,
   * storing the originals for boundary-time resolution.
   *
   * @param text Plain user-authored text (goal, profile context).
   * @returns The text with placeholders substituted; other content untouched.
   */
  public redact(text: string): string {
    let out = text;

    // Auth-shaped query param values first (URL-scoped), so a signed URL keeps
    // its structure and the credential-ish value is still usable after resolve.
    // The shared param-name pattern carries its own capture group, so the value
    // is the THIRD capture (prefix, param name, value).
    out = out.replace(
      new RegExp(AUTH_PARAM_ASSIGNMENT_RE.source, 'gi'),
      (_full, prefix: string, _param: string, value: string) =>
        `${prefix}${this.placeholderFor('auth_param', value)}`,
    );

    out = this.replaceAllMatches(out, SENSITIVE_VALUE_PATTERNS.email, 'email');
    out = this.replaceAllMatches(out, SENSITIVE_VALUE_PATTERNS.ssn, 'ssn');

    // Credit cards keep the payload sanitizer's Luhn + length gate so ordinary
    // long numbers (order ids, tracking numbers) stay visible to the model.
    out = out.replace(
      new RegExp(SENSITIVE_VALUE_PATTERNS.cardCandidate.source, 'g'),
      (candidate) => {
        const digits = candidate.replace(/\D/g, '');
        if (digits.length < 13 || digits.length > 19 || !isLuhnValid(digits)) return candidate;
        return this.placeholderFor('credit_card', candidate);
      },
    );

    out = out.replace(
      new RegExp(SENSITIVE_VALUE_PATTERNS.phoneCandidate.source, 'g'),
      (candidate) => {
        const digits = candidate.replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) return candidate;
        return this.placeholderFor('phone', candidate);
      },
    );

    for (const pattern of SENSITIVE_VALUE_PATTERNS.apiKey) {
      out = this.replaceAllMatches(out, pattern, 'api_key');
    }

    return out;
  }

  /**
   * Restore stored values for every known placeholder in the text. Unknown
   * (model-invented) placeholder shapes are left as-is — nothing to leak.
   * Called only at the tool execution boundary.
   */
  public resolve(text: string): string {
    if (this.valueByPlaceholder.size === 0) return text;
    return text.replace(
      new RegExp(PLACEHOLDER_RE.source, 'g'),
      (token) => this.valueByPlaceholder.get(token) ?? token,
    );
  }

  /**
   * Replace occurrences of stored original values with their placeholders.
   * Applied to model-visible output so echoed values come back as the same
   * stable tokens the model already knows.
   */
  public mask(text: string): string {
    if (this.placeholderByValue.size === 0) return text;
    // Longest-first so an overlapping shorter value cannot clobber a longer one.
    const entries = [...this.placeholderByValue.entries()].sort(
      (left, right) => right[0].length - left[0].length,
    );
    let out = text;
    for (const [value, placeholder] of entries) {
      out = out.split(value).join(placeholder);
    }
    return out;
  }

  private replaceAllMatches(text: string, pattern: RegExp, tag: UserInputValueTag): string {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return text.replace(new RegExp(pattern.source, flags), (match) =>
      this.placeholderFor(tag, match),
    );
  }

  private placeholderFor(tag: UserInputValueTag, value: string): string {
    const existing = this.placeholderByValue.get(value);
    if (existing !== undefined) return existing;
    const next = (this.countersByTag.get(tag) ?? 0) + 1;
    this.countersByTag.set(tag, next);
    const placeholder = `{{user:${tag}:${next}}}`;
    this.placeholderByValue.set(value, placeholder);
    this.valueByPlaceholder.set(placeholder, value);
    return placeholder;
  }
}
