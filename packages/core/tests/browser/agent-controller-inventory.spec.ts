import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentBrowserController } from '../../src/browser/agent-controller.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

describe('@no-llm complete controller inventory', () => {
  let controller: AgentBrowserController;
  let fixture: MigrationBrowserFixture;
  beforeEach(async () => {
    fixture = await beginMigrationBrowserFixture();
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const provider = new LocalBrowserProvider({ profileStore: new LocalProfileStore(), logger });
    controller = new AgentBrowserController({
      runId: 'inventory',
      browserProvider: {
        detectChrome: () => provider.detectChrome(),
        launch: (options) => provider.launch({ ...options, ...fixture.launchOptions }),
      },
    });
    await controller.navigate('about:blank');
  });
  afterEach(async () => {
    await controller?.teardown();
    await fixture?.cleanup();
  });

  it('registers unseen refs and takes one census including invisible fields', async () => {
    await controller.evaluate(() => {
      document.body.innerHTML =
        Array.from(
          { length: 98 },
          (_, i) => `<input aria-label="Field ${i}" style="display:block">`,
        ).join('') +
        '<input aria-label="Hidden" style="display:none"><input aria-label="Disabled" disabled>' +
        '<div class="g-recaptcha"><input aria-label="Challenge"></div><input type="hidden">' +
        '<fieldset><input type="checkbox"><input type="checkbox"></fieldset>' +
        '<input type="radio" name="choice"><input type="radio" name="choice">';
    });
    const observation = await controller.observe();
    expect(observation.interactables).toHaveLength(50);
    expect(observation.inventory).toMatchObject({
      total: 104,
      shown: 50,
      omitted: { field: 54 },
      continueAfter: 'e50',
      scanBounded: false,
    });
    expect(controller.describeRef('e75')?.name).toBe('Field 74');
    await controller.fill('e75', 'Synthetic');
    expect(
      await controller.evaluateOn('e75', (element) => (element as HTMLInputElement).value),
    ).toBe('Synthetic');
    const read = vi.spyOn(controller, 'observe');
    const census = await controller.fillCensus();
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({ cap: 400, trackDigest: false });
    expect(census.complete).toBe(true);
    read.mockClear();
    expect(controller.latestFillCensus()).toEqual(census);
    expect(read).not.toHaveBeenCalled();
    await controller.navigate('about:blank');
    expect(controller.latestFillCensus()).toBeNull();
    expect(census.controls).toHaveLength(105);
    expect(census.controls.find((entry) => entry.label === 'Hidden')?.exemption).toBe('hidden');
    expect(census.controls.find((entry) => entry.label === 'Disabled')?.exemption).toBe('disabled');
    expect(census.controls.find((entry) => entry.label === 'Challenge')?.exemption).toBe(
      'human_verification',
    );
    const grouped = census.controls.filter((entry) => entry.groupKey);
    expect(grouped).toHaveLength(4);
    expect(new Set(grouped.map((entry) => entry.groupKey)).size).toBe(2);
  }, 45_000);

  it('marks a bounded census incomplete and fails closed on read errors', async () => {
    await controller.evaluate(() => {
      document.body.innerHTML = '<input>'.repeat(450);
    });
    expect((await controller.fillCensus()).complete).toBe(false);
    vi.spyOn(controller, 'observe').mockRejectedValueOnce(new Error('unreadable'));
    expect(await controller.fillCensus()).toMatchObject({ complete: false, controls: [] });
  }, 45_000);

  it('continues without losing refs or consuming the model digest', async () => {
    await controller.evaluate(() => {
      document.body.innerHTML = Array.from({ length: 98 }, (_, i) =>
        i < 60
          ? `<input aria-label="Field ${i}" style="display:block">`
          : `<button>Button ${i}</button>`,
      ).join('');
    });
    let observation = await controller.observe();
    const seen = observation.interactables.map((entry) => entry.ref);
    expect(observation.inventory.total).toBe(98);
    while (observation.inventory.continueAfter) {
      observation = await controller.observe({
        window: { after: observation.inventory.continueAfter },
      });
      expect(observation.digest).toBe('');
      seen.push(...observation.interactables.map((entry) => entry.ref));
    }
    expect(seen).toHaveLength(98);
    expect(new Set(seen).size).toBe(98);
    expect(observation.inventory.skippedBefore).toBe(50);
    expect((await controller.observe()).digestUnchanged).toBe(true);
    const fields = await controller.observe({ window: { kinds: ['field'], after: 'e50' } });
    expect(fields.inventory).toMatchObject({ total: 60, shown: 10, skippedBefore: 50 });
    expect(fields.interactables.every((entry) => entry.role === 'textbox')).toBe(true);
    await expect(controller.observe({ window: { after: 'e9999' } })).rejects.toMatchObject({
      code: 'STALE_ELEMENT_REF',
      reason: 'continuation-cursor',
    });
  }, 45_000);
});
