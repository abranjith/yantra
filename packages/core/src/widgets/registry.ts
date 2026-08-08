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
