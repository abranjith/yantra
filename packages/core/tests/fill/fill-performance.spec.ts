import { readFileSync, writeFileSync } from 'node:fs';

import { fortyControls, fortyControlValue } from '@yantra/test-helpers/layout-matrix';
import { describe, expect, it, vi } from 'vitest';

import { fillField } from '../../src/fill/engine.js';
import { createRunState } from '../../src/interaction/escalation.js';
import type { WidgetPort } from '../../src/widgets/types.js';
import { layoutBrowser } from '../helpers/layout-browser.js';

describe('@no-llm plain-field performance', () => {
  it('measures forty explicitly labelled controls in real Chrome', async () => {
    const browser = await layoutBrowser();
    try {
      await browser.page.setContent(fortyControls.html());
      expect(await browser.page.$$('[data-fixture-key]')).toHaveLength(40);
      expect(new Set(fortyControls.controls.map((c) => c.key)).size).toBe(40);
      expect(fortyControls.html()).not.toMatch(
        /aria-autocomplete|aria-haspopup|role="combobox"|list=/,
      );
      const observation = await browser.controller.observe({ cap: 400 });
      const reads = vi.spyOn(browser.controller, 'evaluateOn');
      const port: WidgetPort = {
        observe: (options) => browser.controller.observe(options),
        evaluateOn: (ref, fn, ...args) => browser.controller.evaluateOn(ref, fn, ...args),
        evaluate: (fn, ...args) => browser.controller.evaluate(fn, ...args),
        fill: async (ref, value) => {
          await browser.controller.fill(ref, value);
        },
        type: async (ref, value, options) => {
          await browser.controller.type(ref, value, options);
        },
        clear: async (ref) => {
          await browser.controller.clear(ref);
        },
        click: async (ref) => {
          await browser.controller.click(ref);
        },
        press: async (key) => {
          await browser.controller.press(key);
        },
        scrollContainer: (container, step) => browser.controller.scrollContainer(container, step),
        now: () => Date.now(),
      };
      const durations: Record<string, number[]> = {};
      let fullWatch = 0;
      let firstBatchMs = 0;
      const started = Date.now();
      for (let i = 0; i < 40; i++) {
        const entry = observation.interactables.find(
          (e) => e.name === `Field ${i}` || e.field?.label === `Field ${i}`,
        )!;
        expect(entry).toBeDefined();
        const limits = { deadlineMs: Date.now() + 20_000, maxActions: 8 };
        const run = createRunState({ ...limits, maxReacquisitions: 1 }, port.now());
        const before = Date.now();
        const value = fortyControlValue(i);
        const outcome = await fillField(
          port,
          { field: entry.ref, target: { ...entry, group: entry.group ?? null, value: null } },
          i >= 31 && i < 37 ? { kind: 'toggle', checked: true } : { kind: 'text', text: value },
          { ...limits, run },
        );
        expect(outcome.ok).toBe(true);
        if (i === 9) firstBatchMs = Date.now() - started;
        const kind = i >= 27 && i < 31 ? 'select' : i >= 31 && i < 37 ? 'toggle' : 'plain';
        (durations[kind] ??= []).push(Date.now() - before);
        fullWatch += run.verdicts.filter(
          (v) => v.rungId === 'watch-and-select' && v.kind !== 'skipped',
        ).length;
      }
      const total = Date.now() - started;
      const measurement = {
        measured_at: new Date().toISOString(),
        chrome_version: await browser.page.browser().version(),
        fields: 40,
        total_ms: total,
        p50_ms_by_kind: Object.fromEntries(
          Object.entries(durations).map(([k, values]) => [
            k,
            values.sort((a, b) => a - b)[Math.floor(values.length / 2)],
          ]),
        ),
        evaluate_on: reads.mock.calls.length,
        full_watch_entries: fullWatch,
      };
      const path = new URL('../fixtures/fill-performance/baseline.json', import.meta.url);
      if (process.env.UPDATE_FILL_AFTER === '1') {
        const baseline = JSON.parse(readFileSync(path, 'utf8'));
        writeFileSync(path, JSON.stringify({ ...baseline, after: measurement }, null, 2) + '\n');
      }
      {
        expect(fullWatch).toBe(0);
        expect(total).toBeLessThanOrEqual(60_000);
        expect(firstBatchMs).toBeLessThanOrEqual(15_000);
        const bytes = readFileSync(path);
        expect(
          [...bytes].some((byte) => byte < 32 && byte !== 10 && byte !== 13 && byte !== 9),
        ).toBe(false);
        expect(JSON.parse(bytes.toString('utf8')).fields).toBe(40);
      }
      expect(
        await browser.page.evaluate(() => (window as unknown as { __submits: number }).__submits),
      ).toBe(0);
    } finally {
      await browser.close();
    }
  }, 240_000);
});
