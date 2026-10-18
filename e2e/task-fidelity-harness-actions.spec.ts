/** @no-llm Independent form-state witness and action scoring. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalBrowserProvider,
  LocalProfileStore,
  resetPathCache,
  type BrowserSession,
} from '@yantra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BENCHMARK_RULES, FORM_LAB_PAGES } from './task-fidelity/fixtures/form-lab.js';
import { latestFormStates, protectedDigest } from './task-fidelity/fixtures/form-state.js';
import { hostMappedBrowserProvider } from './task-fidelity/fixtures/host-mapping.js';
import { serveTaskSites, type TaskSiteServer } from './task-fidelity/fixtures/server.js';

describe('@no-llm form-state witness in real Chrome', () => {
  let server: TaskSiteServer;
  let session: BrowserSession;
  let home: string;
  const previous = process.env.YANTRA_HOME;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'yantra-form-state-'));
    process.env.YANTRA_HOME = home;
    resetPathCache();
    server = await serveTaskSites();
    session = await hostMappedBrowserProvider(
      new LocalBrowserProvider({ profileStore: new LocalProfileStore() }),
      server.port,
    ).launch({ profile: { kind: 'ephemeral' }, headless: true });
  }, 60000);
  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (previous === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = previous;
    resetPathCache();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it('records typed values, hashes protected text, and counts all submit paths independently', async () => {
    const page = await session.newPage();
    try {
      await page.goto('https://form-lab.yantra.test/table-label-cell', { waitUntil: 'load' });
      await page.evaluate(async () => {
        for (const [key, value] of [
          ['first', 'Avery'],
          ['last', 'River'],
        ]) {
          const control = document.querySelector<HTMLInputElement>(`[data-fixture-key="${key}"]`)!;
          control.value = value!;
          control.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const password = document.createElement('input');
        password.type = 'password';
        password.dataset.fixtureKey = 'protected';
        password.value = 'fixture-protected-canary';
        document.querySelector('form')!.append(password);
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.dataset.fixtureKey = 'radio';
        radio.checked = true;
        document.querySelector('form')!.append(radio);
        document.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
        const form = document.querySelector('form')!;
        form.requestSubmit();
        form.submit();
        await (window as unknown as { flushFixtureState(): Promise<void> }).flushFixtureState();
      });
      const state = latestFormStates(server.stateLog())['table-label-cell']!;
      expect(state.controls).toMatchObject({
        first: { value: 'Avery' },
        last: { value: 'River' },
        radio: { checked: true },
        protected: { digest: protectedDigest('fixture-protected-canary') },
      });
      expect(JSON.stringify(server.stateLog())).not.toContain('fixture-protected-canary');
      expect(state).toMatchObject({ submits: 2, requestSubmitCalls: 1, formSubmitCalls: 1 });
      expect(page.url()).toBe('https://form-lab.yantra.test/table-label-cell');
      expect(server.requests().some((request) => request.path === '/__fixture/state')).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);

  it('has exactly one authored rule for every control, with untouched exemptions', async () => {
    const page = await session.newPage();
    try {
      for (const id of FORM_LAB_PAGES) {
        await page.goto(`https://form-lab.yantra.test/${id}`, { waitUntil: 'load' });
        const keys = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-fixture-key]')].map(
            (control) => control.dataset.fixtureKey!,
          ),
        );
        expect(keys.sort()).toEqual(Object.keys(BENCHMARK_RULES[id]!).sort());
        expect(new Set(keys).size).toBe(keys.length);
        for (const key of ['disabled', 'readonly', 'file'])
          expect(BENCHMARK_RULES[id]![key]).toEqual({ kind: 'untouched' });
      }
    } finally {
      await page.close();
    }
  }, 30000);
});
