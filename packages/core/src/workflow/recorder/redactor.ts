/**
 * Value redaction at capture time — the structural security guarantee.
 *
 * The `CaptureRedactor` is the ONLY place where `raw_value` is ever read.
 * After redaction the original string is discarded; only `value_length` is kept.
 *
 * TypeScript enforces this boundary: `appendAction` in `RecordingStore` accepts
 * `CapturedAction` (post-redaction shape), NOT `RawCapturedActionInput`.
 * Attempting to skip the redactor is a compile-time error.
 *
 * // SECURITY: only redaction site
 */

import type {
  CapturedAction,
  RawCapturedActionInput,
  RawFillAction,
} from '@yantra/protocol';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Contract for stripping raw values from fill actions before any persistence.
 *
 * @example
 * const redacted = redactor.redact(rawInput);
 * // redacted.raw_value === '<redacted>'
 */
export interface CaptureRedactor {
  /**
   * Strip raw values from a fill action BEFORE it crosses any persistence boundary.
   * Idempotent on non-fill actions. Returns a NEW object — never mutates the input.
   *
   * @param action - The raw action, possibly carrying a plaintext fill value
   * @returns A `CapturedAction` with `raw_value` replaced by the literal `'<redacted>'`
   */
  redact(action: RawCapturedActionInput): CapturedAction;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

/** Regex patterns for common credential shapes — defense-in-depth on top of structural redaction. */
const CREDENTIAL_PATTERNS = [
  /sk-[A-Za-z0-9-]{10,}/g,
  /ghp_[A-Za-z0-9]{10,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}/g,
  /xoxb-[A-Za-z0-9-]{10,}/g,
  /gho_[A-Za-z0-9]{10,}/g,
  /glpat-[A-Za-z0-9_-]{10,}/g,
];

/**
 * Default implementation of `CaptureRedactor`.
 *
 * For `fill` actions: replaces `raw_value` with `'<redacted>'`, computes
 * `value_length` (code-point count), and best-effort zeros the input buffer.
 * For all other action kinds: passes through unchanged (they carry no raw values).
 */
export class DefaultCaptureRedactor implements CaptureRedactor {
  /**
   * @param action - Raw captured action (may contain plaintext fill value)
   * @returns Post-redaction `CapturedAction` — safe to persist
   */
  // SECURITY: only redaction site — raw_value is accessed ONLY here
  redact(action: RawCapturedActionInput): CapturedAction {
    if (action.kind !== 'fill') {
      return action as CapturedAction;
    }

    const raw = (action as RawFillAction).raw_value;

    // Count code points (handles surrogate pairs correctly)
    const valueLength = [...raw].length;

    // Best-effort: fill the string-backed buffer with zeros
    // (Node's V8 strings are immutable; this is defense-in-depth, not a guarantee)
    const buffer = Buffer.from(raw, 'utf8');
    buffer.fill(0);

    const { raw_value: _dropped, ...rest } = action as RawFillAction;
    void _dropped;

    return {
      ...rest,
      raw_value: '<redacted>',
      value_length: valueLength,
    } satisfies CapturedAction;
  }
}

// ---------------------------------------------------------------------------
// Attr-sample defang helper (shared with descriptor-builder)
// ---------------------------------------------------------------------------

/**
 * Strips common credential-shaped strings from an attribute value.
 * Applied to ElementDescriptor.attrs_sample values as defense-in-depth.
 *
 * @param value - Raw attribute value
 * @returns Defanged value, or `'<defanged>'` if a credential pattern matched
 */
export function defangAttrValue(value: string): string {
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      return '<defanged>';
    }
  }
  return value;
}
