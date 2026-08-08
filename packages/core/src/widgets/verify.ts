import type { WidgetIntent, WidgetPort, WidgetTarget } from './types.js';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const TEXTUAL_DATE_LOCALES = [
  'en-US',
  'en-GB',
  'fr-FR',
  'de-DE',
  'es-ES',
  'it-IT',
  'pt-BR',
  'nl-NL',
  'pl-PL',
  'sv-SE',
  'da-DK',
  'nb-NO',
  'fi-FI',
  'cs-CZ',
  'tr-TR',
  'ja-JP',
  'ko-KR',
  'zh-CN',
] as const;

interface ParsedDatePart {
  readonly year: number | null;
  readonly month: number;
  readonly day: number;
}

/** Read the trigger's current non-secret value, falling back to its accessible name. */
export async function readCommitted(port: WidgetPort, target: WidgetTarget): Promise<string> {
  return port.evaluateOn(target.ref, (element) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? '').replace(/\s+/g, ' ').trim();
    if (element instanceof HTMLSelectElement) {
      const selected = element.selectedOptions[0];
      const label = selected?.label ?? '';
      return normalize(label.length > 0 ? label : (selected?.text ?? element.value));
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const autocomplete = element.getAttribute('autocomplete') ?? '';
      if (
        element.matches('input[type="password"]') ||
        /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)\b/i.test(
          autocomplete,
        ) ||
        element.hasAttribute('data-yantra-secret')
      ) {
        return '';
      }
      return normalize(element.value);
    }
    const ariaValue = element.getAttribute('aria-valuetext');
    if (ariaValue?.trim()) return normalize(ariaValue);
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel?.trim()) return normalize(ariaLabel);
    const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
    const linkedLabel = labelledBy
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (linkedLabel.trim()) return normalize(linkedLabel);
    return normalize(element.textContent);
  });
}

/** Compare a rendered committed value with the semantic intent. */
export function matchesIntent(committed: string, intent: WidgetIntent): boolean {
  if (intent.kind === 'option') {
    const actual = normalizeOption(committed);
    const wanted = normalizeOption(intent.value);
    return (
      actual.length > 0 && wanted.length > 0 && (actual.includes(wanted) || wanted.includes(actual))
    );
  }
  const expected =
    intent.kind === 'date' ? [parseIso(intent.date)] : [parseIso(intent.from), parseIso(intent.to)];
  if (expected.some((part) => part === null)) return false;
  const actual = parseRenderedDates(committed);
  let cursor = 0;
  let parsedMatch = true;
  for (const wanted of expected) {
    if (wanted === null) return false;
    const found = actual.findIndex(
      (part, index) =>
        index >= cursor &&
        part.month === wanted.month &&
        part.day === wanted.day &&
        (part.year === null || part.year === wanted.year),
    );
    if (found < 0) {
      parsedMatch = false;
      break;
    }
    cursor = found + 1;
  }
  if (parsedMatch) return true;
  return matchesIntlRenderedDates(
    committed,
    expected.filter((part): part is ParsedDatePart => part !== null),
  );
}

function matchesIntlRenderedDates(committed: string, expected: readonly ParsedDatePart[]): boolean {
  const normalized = normalizeDateText(committed);
  let cursor = 0;
  for (const part of expected) {
    const date = new Date(Date.UTC(part.year!, part.month - 1, part.day));
    const variants = new Set<string>();
    for (const locale of TEXTUAL_DATE_LOCALES) {
      for (const month of ['long', 'short'] as const) {
        for (const includeYear of [true, false]) {
          variants.add(
            normalizeDateText(
              new Intl.DateTimeFormat(locale, {
                day: 'numeric',
                month,
                ...(includeYear ? { year: 'numeric' as const } : {}),
                timeZone: 'UTC',
              }).format(date),
            ),
          );
        }
      }
    }
    const found = [...variants]
      .map((variant) => normalized.indexOf(variant, cursor))
      .filter((index) => index >= cursor)
      .sort((left, right) => left - right)[0];
    if (found === undefined) return false;
    cursor = found + 1;
  }
  return true;
}

function parseIso(value: string): ParsedDatePart | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function parseRenderedDates(value: string): ParsedDatePart[] {
  const found: (ParsedDatePart & { readonly index: number })[] = [];
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  for (const match of value.matchAll(iso)) {
    const parsed = parseIso(match[0]);
    if (parsed) found.push({ ...parsed, index: match.index ?? 0 });
  }
  const monthPattern = MONTHS.map((month) => `${month}|${month.slice(0, 3)}`).join('|');
  const named = new RegExp(
    `\\b(${monthPattern})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`,
    'gi',
  );
  for (const match of value.matchAll(named)) {
    const monthName = match[1]!.toLowerCase().slice(0, 3);
    const month = MONTHS.findIndex((entry) => entry.startsWith(monthName)) + 1;
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : null;
    if (month > 0 && day >= 1 && day <= 31) {
      found.push({ month, day, year, index: match.index ?? 0 });
    }
  }
  const numeric = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g;
  for (const match of value.matchAll(numeric)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      found.push({ month, day, year, index: match.index ?? 0 });
    }
  }
  return found.sort((left, right) => left.index - right.index);
}

function normalizeOption(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDateText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
