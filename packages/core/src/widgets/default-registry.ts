import { calendarDriver } from './date/calendar-driver.js';
import { dateInputDriver } from './date/date-input-driver.js';
import { listboxDriver } from './option/listbox-driver.js';
import { nativeSelectDriver } from './option/native-select-driver.js';
import { WidgetRegistry } from './registry.js';

/** Build the standard registry in deterministic tie-breaking order. */
export function createDefaultWidgetRegistry(): WidgetRegistry {
  return new WidgetRegistry()
    .registerDriver(nativeSelectDriver)
    .registerDriver(listboxDriver)
    .registerDriver(dateInputDriver)
    .registerDriver(calendarDriver);
}
