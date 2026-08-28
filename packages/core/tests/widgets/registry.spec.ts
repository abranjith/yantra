import { describe, expect, it, vi } from 'vitest';

import { createDefaultWidgetRegistry } from '../../src/widgets/default-registry.js';
import {
  type WidgetDriver,
  type WidgetIntent,
  type WidgetPort,
  type WidgetTarget,
} from '../../src/widgets/index.js';
import { WidgetRegistry } from '../../src/widgets/registry.js';

const TARGET: WidgetTarget = {
  ref: 'e1',
  role: 'button',
  name: 'Dates',
  group: null,
  value: null,
};
const INTENT: WidgetIntent = { kind: 'date', date: '2026-09-06' };

describe('@no-llm widget registry', () => {
  it('selects the highest confidence and uses registration order to break ties', async () => {
    const first = fixedConfidenceDriver('first', 'date', 0.8);
    const tied = driver('tied', 'date', 0.8);
    const highest = driver('highest', 'date', 0.9);
    const registry = new WidgetRegistry()
      .registerDriver(first)
      .registerDriver(tied)
      .registerDriver(highest);

    expect((await registry.detectDriver(port(), TARGET))?.driver.kind).toBe('highest');

    const tieRegistry = new WidgetRegistry().registerDriver(first).registerDriver(tied);
    expect((await tieRegistry.detectDriver(port(), TARGET))?.driver.kind).toBe('first');
  });

  it('does not drive when no driver reaches the confidence threshold', async () => {
    const low = driver('low', 'date', 0.49);
    const registry = new WidgetRegistry().registerDriver(low);

    const outcome = await registry.driveWidget(port(), TARGET, INTENT);

    expect(outcome).toMatchObject({ ok: false, errorCode: 'WIDGET_NOT_RECOGNIZED' });
    expect(low.drive).not.toHaveBeenCalled();
  });

  it('restricts detection to the requested family', async () => {
    const option = driver('option', 'option', 1);
    const date = driver('date', 'date', 0.6);
    const registry = new WidgetRegistry().registerDriver(option).registerDriver(date);

    expect((await registry.detectDriver(port(), TARGET, 'date'))?.driver.kind).toBe('date');
  });

  it('keeps detection read-only', async () => {
    const widgetPort = port();
    const detecting = driver('reader', 'date', 0.8, async (candidatePort) => {
      await candidatePort.evaluate(() => document.title);
      return 0.8;
    });
    const registry = new WidgetRegistry().registerDriver(detecting);

    await registry.detectDriver(widgetPort, TARGET);

    expect(widgetPort.click).not.toHaveBeenCalled();
    expect(widgetPort.fill).not.toHaveBeenCalled();
  });
});

function driver(
  kind: string,
  family: WidgetDriver['family'],
  confidence: number,
  detect?: WidgetDriver['detect'],
): WidgetDriver {
  return {
    kind,
    family,
    detect: detect ?? vi.fn(async () => confidence),
    drive: vi.fn(async () => ({ ok: true, driver: kind, committed: 'done', actions: 1 })),
  };
}

function port(): WidgetPort {
  return {
    observe: vi.fn(),
    click: vi.fn(),
    fill: vi.fn(),
    clear: vi.fn(),
    type: vi.fn(),
    evaluateOn: vi.fn(),
    evaluate: vi.fn(async () => ''),
    press: vi.fn(),
    now: vi.fn(() => 0),
  } as unknown as WidgetPort;
}

describe('@no-llm ordered driver detection', () => {
  it('returns every confident driver, strongest first', async () => {
    const registry = new WidgetRegistry()
      .registerDriver(fixedConfidenceDriver('weak', 'date', 0.6))
      .registerDriver(fixedConfidenceDriver('strong', 'date', 0.95));

    const detected = await registry.detectDrivers(port(), aTarget(), 'date');

    expect(detected.map((entry) => entry.driver.kind)).toEqual(['strong', 'weak']);
  });

  it('keeps registration order among equal confidences', async () => {
    const registry = new WidgetRegistry()
      .registerDriver(fixedConfidenceDriver('first', 'date', 0.8))
      .registerDriver(fixedConfidenceDriver('second', 'date', 0.8))
      .registerDriver(fixedConfidenceDriver('third', 'date', 0.8));

    const detected = await registry.detectDrivers(port(), aTarget(), 'date');

    expect(detected.map((entry) => entry.driver.kind)).toEqual(['first', 'second', 'third']);
  });

  it('excludes drivers below the confidence threshold and other families', async () => {
    const registry = new WidgetRegistry()
      .registerDriver(fixedConfidenceDriver('unsure', 'date', 0.2))
      .registerDriver(fixedConfidenceDriver('other-family', 'option', 0.99))
      .registerDriver(fixedConfidenceDriver('confident', 'date', 0.7));

    const detected = await registry.detectDrivers(port(), aTarget(), 'date');

    expect(detected.map((entry) => entry.driver.kind)).toEqual(['confident']);
  });

  it('returns an empty field rather than a guess when nothing is confident', async () => {
    const registry = new WidgetRegistry().registerDriver(
      fixedConfidenceDriver('unsure', 'date', 0.1),
    );

    expect(await registry.detectDrivers(port(), aTarget(), 'date')).toEqual([]);
  });
});

describe('@no-llm default widget registry', () => {
  it('is reachable from production code and holds one driver per shape', () => {
    // It was dead code until the fill engine started selecting drivers through
    // it; a second, divergent typeahead implementation lived here unused.
    const registry = createDefaultWidgetRegistry();
    expect(registry).toBeInstanceOf(WidgetRegistry);
  });
});

/** A stub driver reporting a fixed confidence. */
function fixedConfidenceDriver(
  kind: string,
  family: 'date' | 'option',
  confidence: number,
): WidgetDriver {
  return {
    kind,
    family,
    detect: async () => confidence,
    drive: async () => ({ ok: true, driver: kind, committed: '', actions: 0 }),
  };
}

function aTarget(): WidgetTarget {
  return { ref: 'e1', role: 'textbox', name: 'Choose date', group: null, value: null };
}
