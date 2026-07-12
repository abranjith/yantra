/**
 * Entity-normalization helpers shared by every {@link TextAnalyzer}
 * implementation, so a `"$7,500"` from the regex baseline and from winkNLP's
 * NER normalize to the same comparable key (`"7500"`). Keeping these in one
 * place is what lets cross-source numeric matching stay analyzer-agnostic.
 */

/**
 * Canonicalizes a numeric surface form (money / percent / cardinal) to its
 * digits and decimal point only: currency symbols, `%`, thousands separators,
 * whitespace, and any surrounding words are stripped.
 *
 * @param surface - The entity's surface text (for example `"$7,500"`).
 * @returns Digits-and-dots key (for example `"7500"`).
 */
export function normalizeNumeric(surface: string): string {
  return surface.replace(/[^\d.]/gu, '');
}

/**
 * Canonicalizes a date surface form to a compact lower-case key.
 *
 * @param surface - The entity's surface text (for example `"Q1 2026"`).
 * @returns Lower-cased, whitespace-collapsed key.
 */
export function normalizeDate(surface: string): string {
  return surface.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Canonicalizes a named-entity surface form to a lower-case, collapsed key.
 *
 * @param surface - The entity's surface text (for example `"Cox Automotive"`).
 * @returns Lower-cased, whitespace-collapsed key.
 */
export function normalizeNamed(surface: string): string {
  return surface.toLowerCase().replace(/\s+/gu, ' ').trim();
}
