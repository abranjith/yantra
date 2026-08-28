import { widgetFailure, type WidgetDriver, type WidgetPort, type WidgetTarget } from '../types.js';
import { readCommitted } from '../verify.js';

import { resolveDatePair } from './date-pair.js';

type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';

/** Driver for native, format-signalled, and paired text date inputs. */
export const dateInputDriver: WidgetDriver = {
  kind: 'date-input',
  family: 'date',
  /**
   * Confidence that this control accepts a *typed* date.
   *
   * The name hint alone is far too eager. A calendar trigger is very often an
   * `<input readonly>` labelled "Choose date" and showing a formatted value —
   * this driver typed an ISO date into one of those, the control kept its own
   * value, and the whole fill stopped there rather than reaching the calendar
   * the trigger exists to open.
   *
   * So the disqualifying signals come first, and they are structural: a control
   * that cannot be typed into, or that declares it opens something, is not a
   * date input however it is named.
   */
  detect: async (port, target) =>
    port.evaluateOn(target.ref, (element) => {
      if (!(element instanceof HTMLInputElement)) return 0;
      if (element.readOnly || element.disabled) return 0;
      const popup = element.getAttribute('aria-haspopup')?.toLowerCase() ?? '';
      if (['dialog', 'grid', 'listbox', 'menu', 'tree'].includes(popup)) return 0;
      if (element.type.toLowerCase() === 'date') return 1;
      const hint = [element.placeholder, element.pattern, element.getAttribute('aria-label') ?? '']
        .join(' ')
        .toLowerCase();
      // An explicit format hint is a real signal that typing is expected; a
      // bare mention of "date" in an accessible name is not, so it ranks below
      // the calendar driver rather than pre-empting it.
      if (/(?:mm|dd|yyyy)/.test(hint)) return 0.9;
      return hint.includes('date') ? 0.6 : 0;
    }),
  drive: async (port, target, intent, budget) => {
    if (port.now() > budget.deadlineMs || budget.maxActions < 1) {
      return widgetFailure('WIDGET_TARGET_UNREACHABLE', 'The widget action budget was exhausted.', {
        reason: 'budget',
      });
    }

    if (intent.kind === 'date') {
      const committed = await fillDateInput(port, target, intent.date);
      if (!committed.ok) return committed.failure;
      return { ok: true, driver: 'date-input', committed: committed.value, actions: 1 };
    }

    if (intent.kind !== 'date_range') {
      return widgetFailure('WIDGET_TARGET_UNREACHABLE', 'A date input accepts only date intents.');
    }
    if (budget.maxActions < 2) {
      return widgetFailure('WIDGET_TARGET_UNREACHABLE', 'The widget action budget was exhausted.', {
        reason: 'budget',
      });
    }
    const pair = await resolveDatePair(port, target);
    if (!pair) {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        `The date range field "${target.name}" did not resolve to one check-in and one check-out input.`,
        { reason: 'paired_inputs_not_found' },
      );
    }
    const from = await fillDateInput(port, pair.from, intent.from);
    if (!from.ok) return from.failure;
    const to = await fillDateInput(port, pair.to, intent.to);
    if (!to.ok) return to.failure;
    return {
      ok: true,
      driver: 'date-input-range',
      committed: `${from.value}..${to.value}`,
      actions: 2,
    };
  },
};

async function fillDateInput(
  port: WidgetPort,
  target: WidgetTarget,
  isoDate: string,
): Promise<
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly failure: ReturnType<typeof widgetFailure> }
> {
  const format = await detectFormat(port, target);
  const formatted = formatDate(isoDate, format);
  await port.fill(target.ref, formatted);
  await port.evaluateOn(target.ref, (element) => {
    const EventCtor = element.ownerDocument.defaultView?.Event;
    if (!EventCtor) return;
    element.dispatchEvent(new EventCtor('input', { bubbles: true }));
    element.dispatchEvent(new EventCtor('change', { bubbles: true }));
  });
  const committed = await readCommitted(port, target);
  if (parseCommitted(committed, format) !== isoDate) {
    return {
      ok: false,
      failure: widgetFailure('WIDGET_NOT_COMMITTED', `The date input did not commit ${isoDate}.`, {
        committed,
        format,
      }),
    };
  }
  return { ok: true, value: committed };
}

async function detectFormat(port: WidgetPort, target: WidgetTarget): Promise<DateFormat> {
  return port.evaluateOn(target.ref, (element) => {
    if (!(element instanceof HTMLInputElement)) return 'YYYY-MM-DD' as const;
    if (element.type.toLowerCase() === 'date') return 'YYYY-MM-DD' as const;
    const hint = `${element.placeholder} ${element.pattern}`.toUpperCase();
    const compact = hint.replace(/[^YMD]/g, '');
    if (compact.includes('DDMMYYYY')) return 'DD/MM/YYYY' as const;
    if (compact.includes('MMDDYYYY')) return 'MM/DD/YYYY' as const;
    return 'YYYY-MM-DD' as const;
  });
}

function formatDate(isoDate: string, format: DateFormat): string {
  const [year, month, day] = isoDate.split('-');
  if (format === 'DD/MM/YYYY') return `${day}/${month}/${year}`;
  if (format === 'MM/DD/YYYY') return `${month}/${day}/${year}`;
  return isoDate;
}

function parseCommitted(value: string, format: DateFormat): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return validIso(trimmed) ? trimmed : null;
  const match = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(trimmed);
  if (!match) return null;
  const first = match[1]!.padStart(2, '0');
  const second = match[2]!.padStart(2, '0');
  const iso =
    format === 'DD/MM/YYYY' ? `${match[3]}-${second}-${first}` : `${match[3]}-${first}-${second}`;
  return validIso(iso) ? iso : null;
}

function validIso(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}
