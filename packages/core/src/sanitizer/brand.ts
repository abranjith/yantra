/**
 * The `Sanitized<T>` brand — a compile-time proof that a value has passed
 * through the single sanitizer chokepoint.
 *
 * The brand is a phantom type: it adds no runtime bytes, but a plain `string`
 * is not assignable to a `Sanitized<string>` parameter, so a caller cannot slip
 * un-sanitized text into a slot that demands the brand. Used by the
 * personalization builder (TASK-004) so only `sanitize()`-derived text can enter
 * `SynthesisOptions.personalization`.
 */

declare const sanitizedTag: unique symbol;

/** A value that has passed through `sanitize()`. */
export type Sanitized<T> = T & { readonly [sanitizedTag]: true };

/**
 * Brands a value as sanitized. **Only call this immediately after `sanitize()`**
 * — the brand is a trust marker and mislabeling defeats its purpose.
 */
export function brandSanitized<T>(value: T): Sanitized<T> {
  return value as Sanitized<T>;
}
