import { widgetFailure, type WidgetDriver } from '../types.js';
import { matchesIntent, readCommitted } from '../verify.js';

/** Driver for native and format-signalled text date inputs. */
export const dateInputDriver: WidgetDriver = {
  kind: 'date-input',
  family: 'date',
  detect: async (port, target) =>
    port.evaluateOn(target.ref, (element) => {
      if (!(element instanceof HTMLInputElement)) return 0;
      if (element.type.toLowerCase() === 'date') return 1;
      const hint = [element.placeholder, element.pattern, element.getAttribute('aria-label') ?? '']
        .join(' ')
        .toLowerCase();
      return /\b(?:date|mm|dd|yyyy)\b/.test(hint) ? 0.8 : 0;
    }),
  drive: async (port, target, intent, budget) => {
    if (intent.kind !== 'date') {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'A single date input cannot express a date range.',
        { reason: 'range_not_supported' },
      );
    }
    if (port.now() > budget.deadlineMs || budget.maxActions < 1) {
      return widgetFailure('WIDGET_TARGET_UNREACHABLE', 'The widget action budget was exhausted.', {
        reason: 'budget',
      });
    }
    const formatted = await port.evaluateOn(
      target.ref,
      (element, isoDate) => {
        if (!(element instanceof HTMLInputElement)) return isoDate;
        if (element.type.toLowerCase() === 'date') return isoDate;
        const [year, month, day] = isoDate.split('-');
        const hint = `${element.placeholder} ${element.pattern}`.toLowerCase();
        if (/dd[^a-z0-9]*mm[^a-z0-9]*yyyy/.test(hint)) return `${day}/${month}/${year}`;
        if (/mm[^a-z0-9]*dd[^a-z0-9]*yyyy/.test(hint)) return `${month}/${day}/${year}`;
        return isoDate;
      },
      intent.date,
    );
    await port.fill(target.ref, formatted);
    const committed = await readCommitted(port, target);
    if (!matchesIntent(committed, intent)) {
      return widgetFailure(
        'WIDGET_NOT_COMMITTED',
        `The date input did not commit ${intent.date}.`,
        { committed },
      );
    }
    return { ok: true, driver: 'date-input', committed, actions: 1 };
  },
};
