import { widgetFailure, type WidgetDriver } from '../types.js';
import { matchesIntent, readCommitted } from '../verify.js';

/** Driver for native HTML select controls. */
export const nativeSelectDriver: WidgetDriver = {
  kind: 'native-select',
  family: 'option',
  detect: async (port, target) =>
    port.evaluateOn(target.ref, (element) => (element instanceof HTMLSelectElement ? 1 : 0)),
  drive: async (port, target, intent, budget) => {
    if (intent.kind !== 'option') {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'intent-incompatible',
        'A native select accepts only option intents.',
      );
    }
    if (port.now() > budget.deadlineMs || budget.maxActions < 1) {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'budget',
        'The widget action budget was exhausted.',
        { reason: 'budget' },
      );
    }
    await port.fill(target.ref, intent.value);
    const selection = await port.evaluateOn(target.ref, (element) => {
      if (!(element instanceof HTMLSelectElement)) return null;
      const option = element.selectedOptions[0];
      return option ? { label: option.label || option.text, value: option.value } : null;
    });
    const committed = await readCommitted(port, target);
    if (
      selection === null ||
      (!matchesIntent(selection.label, intent) && !matchesIntent(selection.value, intent))
    ) {
      return widgetFailure(
        'WIDGET_NOT_COMMITTED',
        'control-refused-value',
        `The native select did not commit "${intent.value}".`,
        { committed, observed: committed },
      );
    }
    return { ok: true, driver: 'native-select', committed, actions: 1 };
  },
};
