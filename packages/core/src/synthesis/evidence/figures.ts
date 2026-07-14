/** A number claim reduced to one compact key-figures table row. */
export interface KeyFigure {
  readonly figure: string;
  readonly context: string;
  readonly citations: readonly number[];
  /** Original claim used internally to keep table rows out of fallback bullets. */
  readonly sourceText: string;
}

/** Minimal input required to derive a key figure. */
export interface FigureClaim {
  readonly text: string;
  readonly citations: readonly number[];
}

const PRIORITY_FIGURE_PATTERNS = [
  /(?:[$â‚¬Â£]\s?\d[\d,.]*(?:\s?(?:million|billion|trillion))?)/iu,
  /\b\d+(?:\.\d+)?\s?%/u,
] as const;
const QUANTITY_PATTERN =
  /\b\d[\d,.]*(?:\s+(?:teams?|(?:host\s+)?cities|spectators?|matches?|people|units?))?/giu;
const DATE_PATTERN =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/giu;

/**
 * Reduces number claims into deterministic figure/context/citation rows.
 *
 * @param claims - Number-kind claims in display order.
 * @returns Reducible, de-duplicated rows whose context is 12â€“90 characters.
 * @example deriveKeyFigures([{ text: 'Attendance reached 3,605,357 spectators.', citations: [1] }]);
 */
export function deriveKeyFigures(claims: readonly FigureClaim[]): KeyFigure[] {
  const rows: KeyFigure[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    const match = firstPriorityFigure(claim.text);
    if (match === undefined) continue;
    const clause = clauseContaining(claim.text, match.index, match.text.length);
    const context = clause
      .replace(match.text, ' ')
      .replace(/\[\d+\]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .replace(/^[,.;:â€”\s]+|[,;:â€”\s]+$/gu, '')
      .trim();
    if (context.length < 12 || context.length > 90) continue;
    const key = `${match.text.toLowerCase().replace(/\s+/gu, '')}\u0000${context.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      figure: match.text,
      context,
      citations: [...new Set(claim.citations)].sort((a, b) => a - b),
      sourceText: claim.text,
    });
  }
  return rows;
}

function firstPriorityFigure(text: string): { text: string; index: number } | undefined {
  for (const pattern of PRIORITY_FIGURE_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return { text: match[0], index: match.index };
  }
  const dates = [...text.matchAll(DATE_PATTERN)];
  for (const match of text.matchAll(QUANTITY_PATTERN)) {
    const insideDate = dates.some(
      (date) => match.index >= date.index && match.index < date.index + date[0].length,
    );
    if (!insideDate) return { text: match[0], index: match.index };
  }
  const date = dates[0];
  if (date !== undefined) return { text: date[0], index: date.index };
  return undefined;
}

function clauseContaining(text: string, index: number, figureLength: number): string {
  const separators = /[,;â€”:]/gu;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(separators)) {
    const at = match.index;
    if (at >= index && at < index + figureLength) continue;
    if (match[0] === ',' && /\d/u.test(text[at - 1] ?? '') && /\d/u.test(text[at + 1] ?? '')) {
      continue;
    }
    if (at < index) start = at + match[0].length;
    else {
      end = at;
      break;
    }
  }
  return text.slice(start, end);
}
