import {
  defaultWidgetBudget,
  widgetFailure,
  type WidgetBudget,
  type WidgetDriver,
  type WidgetFamily,
  type WidgetIntent,
  type WidgetOutcome,
  type WidgetPort,
  type WidgetTarget,
} from './types.js';

/** Minimum confidence required before a driver may act. */
export const MIN_CONFIDENCE = 0.5;

/** Detection result retaining the winning driver and its confidence. */
export interface DetectedWidgetDriver {
  readonly driver: WidgetDriver;
  readonly confidence: number;
}

/** Ordered registry for pattern-based widget drivers. */
export class WidgetRegistry {
  private readonly drivers: WidgetDriver[] = [];

  /** Register a driver after all existing drivers (registration breaks ties). */
  public registerDriver(driver: WidgetDriver): this {
    this.drivers.push(driver);
    return this;
  }

  /**
   * Every driver confident enough to act, strongest first.
   *
   * Detection is a guess made from closed-state reads, and a wrong guess used
   * to end the attempt: a read-only trigger whose accessible name contains
   * "date" was handed to the driver that types into date inputs, which typed
   * into a control that cannot be typed into and stopped there — with the
   * calendar driver that would have paged to the requested month sitting
   * unconsulted. Returning the ordered field lets the caller fall through when
   * the strongest candidate turns out to be wrong about itself.
   *
   * Ties keep registration order, so selection stays deterministic.
   */
  public async detectDrivers(
    port: WidgetPort,
    target: WidgetTarget,
    family?: WidgetFamily,
  ): Promise<readonly DetectedWidgetDriver[]> {
    const detected: DetectedWidgetDriver[] = [];
    for (const driver of this.drivers) {
      if (family !== undefined && driver.family !== family) continue;
      const raw = await driver.detect(port, target);
      const confidence = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      if (confidence < MIN_CONFIDENCE) continue;
      detected.push({ driver, confidence });
    }
    // A stable sort keeps registration order among equal confidences.
    return detected
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) =>
        right.entry.confidence === left.entry.confidence
          ? left.index - right.index
          : right.entry.confidence - left.entry.confidence,
      )
      .map(({ entry }) => entry);
  }

  /**
   * Detect the highest-confidence driver, optionally within one family.
   * Ties keep the earlier registered driver.
   */
  public async detectDriver(
    port: WidgetPort,
    target: WidgetTarget,
    family?: WidgetFamily,
  ): Promise<DetectedWidgetDriver | null> {
    let selected: DetectedWidgetDriver | null = null;
    for (const driver of this.drivers) {
      if (family !== undefined && driver.family !== family) continue;
      const raw = await driver.detect(port, target);
      const confidence = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      if (confidence < MIN_CONFIDENCE) continue;
      if (selected === null || confidence > selected.confidence) {
        selected = { driver, confidence };
      }
    }
    return selected;
  }

  /** Detect, dispatch, and return a verified semantic widget outcome. */
  public async driveWidget(
    port: WidgetPort,
    target: WidgetTarget,
    intent: WidgetIntent,
    budget: WidgetBudget = defaultWidgetBudget(port),
    family?: WidgetFamily,
  ): Promise<WidgetOutcome> {
    const detected = await this.detectDriver(port, target, family);
    if (detected === null) {
      return widgetFailure(
        'WIDGET_NOT_RECOGNIZED',
        `No ${family ?? 'registered'} widget driver recognized "${target.name}" with sufficient confidence.`,
        { family: family ?? null, threshold: MIN_CONFIDENCE },
      );
    }
    return detected.driver.drive(port, target, intent, budget);
  }
}

const sharedRegistry = new WidgetRegistry();

/** Register a driver in the shared registry. */
export function registerDriver(driver: WidgetDriver): void {
  sharedRegistry.registerDriver(driver);
}

/** Detect a driver from the shared registry. */
export function detectDriver(
  port: WidgetPort,
  target: WidgetTarget,
  family?: WidgetFamily,
): Promise<DetectedWidgetDriver | null> {
  return sharedRegistry.detectDriver(port, target, family);
}

/** Drive a widget through the shared registry. */
export function driveWidget(
  port: WidgetPort,
  target: WidgetTarget,
  intent: WidgetIntent,
  budget: WidgetBudget = defaultWidgetBudget(port),
  family?: WidgetFamily,
): Promise<WidgetOutcome> {
  return sharedRegistry.driveWidget(port, target, intent, budget, family);
}
