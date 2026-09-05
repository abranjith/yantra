import { isOfferedCalendarLabel } from '../widgets/date/calendar-driver.js';

import { fillFailure, type FillFailure, type FillIntent } from './types.js';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_RANGE_RE = /^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/;
const SECRET_SHAPE =
  /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/;
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch']);
const OPTION_ROLES = new Set(['combobox', 'listbox', 'menu', 'radiogroup', 'select']);

/** Parse a model/user value into the semantic intent carried by its shape. */
export function parseFillValue(raw: string, controlKind: string): FillIntent | FillFailure {
  if (SECRET_SHAPE.test(raw)) {
    return fillFailure(
      'FILL_VALUE_INVALID',
      'value-malformed',
      'Credential-shaped text must be supplied as a secret_ref, not a literal fill value.',
      { expected: 'a non-secret literal or secret_ref' },
    );
  }

  // Offered calendar labels are opaque receiver tokens. In particular, their
  // human-readable tail may contain ".."; date syntax must not reinterpret it.
  if (isOfferedCalendarLabel(raw)) {
    return { kind: 'text', text: raw };
  }

  const trimmed = raw.trim();
  const range = DATE_RANGE_RE.exec(trimmed);
  if (range) {
    const from = range[1]!;
    const to = range[2]!;
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
      return invalidDate(
        raw,
        'Use a real ISO range written YYYY-MM-DD..YYYY-MM-DD with the earlier date first.',
      );
    }
    return { kind: 'date_range', from, to };
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed) || trimmed.includes('..')) {
    if (!isIsoDate(trimmed)) {
      return invalidDate(
        raw,
        'Use a real ISO date written YYYY-MM-DD or a range written YYYY-MM-DD..YYYY-MM-DD.',
      );
    }
    return { kind: 'date', date: trimmed };
  }

  if ((trimmed === 'checked' || trimmed === 'unchecked') && TOGGLE_ROLES.has(controlKind)) {
    return { kind: 'toggle', checked: trimmed === 'checked' };
  }

  return OPTION_ROLES.has(controlKind)
    ? { kind: 'option', value: raw }
    : { kind: 'text', text: raw };
}

/** True only for a calendar-valid ISO date. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function invalidDate(value: string, message: string): FillFailure {
  return fillFailure('FILL_VALUE_INVALID', 'value-malformed', message, {
    value,
    expected: 'YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD',
  });
}
