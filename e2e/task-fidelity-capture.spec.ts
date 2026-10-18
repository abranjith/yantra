/**
 * @no-llm task fidelity — the FEAT-058 `tall-page` fixture and capture
 * scenario sources.
 *
 * The scenarios run in the deterministic tier (`task-fidelity.spec.ts`); this
 * suite pins what they rely on: the fixture's geometry is a pure function of
 * its source, the new sources carry no raw control bytes, and the harness
 * modules stay loadable outside Vitest.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderRoute, siteNamed } from './task-fidelity/fixtures/sites.js';
import {
  TALL_PAGE_HEIGHT,
  TALL_PAGE_LONG_HEIGHT,
  TALL_PAGE_LONG_PATH,
  TALL_PAGE_PANEL,
  TALL_PAGE_PANEL_NAME,
  TALL_PAGE_PATH,
  TALL_PAGE_SECRET_FIELD,
} from './task-fidelity/fixtures/tall-page.js';
import { SCENARIOS } from './task-fidelity/scenarios/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Every byte below 0x20 except tab, line feed, and carriage return, plus DEL. */
function controlBytes(bytes: Uint8Array): number[] {
  const found: number[] = [];
  bytes.forEach((byte, index) => {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      found.push(index);
    }
  });
  return found;
}

async function captureSources(): Promise<string[]> {
  const scenarios = (await readdir(join(here, 'task-fidelity', 'scenarios')))
    .filter((name) => name.startsWith('capture-'))
    .map((name) => join(here, 'task-fidelity', 'scenarios', name));
  return [join(here, 'task-fidelity', 'fixtures', 'tall-page.ts'), ...scenarios];
}

describe('@no-llm task fidelity — tall-page fixture (FEAT-058)', () => {
  const site = siteNamed('tall-page');

  it('serves the standard and long pages at their fixed heights', () => {
    const standard = renderRoute(site, TALL_PAGE_PATH)?.body ?? '';
    const long = renderRoute(site, TALL_PAGE_LONG_PATH)?.body ?? '';

    expect(standard).toContain(`height:${TALL_PAGE_HEIGHT}px`);
    expect(long).toContain(`height:${TALL_PAGE_LONG_HEIGHT}px`);
    expect(standard).toContain('html,body{margin:0;padding:0}');
  });

  it('places the labeled panel below the fold and a password control in the form', () => {
    const body = renderRoute(site, TALL_PAGE_PATH)?.body ?? '';

    expect(body).toContain(`top:${TALL_PAGE_PANEL.top}px`);
    expect(body).toContain(`width:${TALL_PAGE_PANEL.width}px;height:${TALL_PAGE_PANEL.height}px`);
    expect(body).toContain(TALL_PAGE_PANEL_NAME);
    expect(body).toContain(`${TALL_PAGE_SECRET_FIELD} <input name="password" type="password"`);
  });

  it('is deterministic and names no unknown route', () => {
    expect(renderRoute(site, TALL_PAGE_PATH)?.body).toBe(renderRoute(site, TALL_PAGE_PATH)?.body);
    expect(renderRoute(site, '/missing')).toBeNull();
  });

  it('registers every capture scenario in the deterministic tier with owner FEAT-058', () => {
    const capture = SCENARIOS.filter((scenario) => scenario.id.startsWith('capture-'));

    expect(capture.map((scenario) => scenario.id).sort()).toEqual([
      'capture-element-below-fold',
      'capture-full-page-tall',
      'capture-full-page-truncated',
      'capture-latched',
      'capture-suppressed',
      'capture-text-only',
      'capture-vision-unchanged',
    ]);
    for (const scenario of capture) {
      expect(scenario.tiers).toEqual(['deterministic']);
      expect(scenario.sites).toEqual(['tall-page']);
      expect(scenario.expectations.some((entry) => entry.owner === 'FEAT-058')).toBe(true);
    }
  });
});

describe('@no-llm task fidelity — capture sources', () => {
  it('carry no raw control bytes', async () => {
    for (const path of await captureSources()) {
      expect({ path, bytes: controlBytes(await readFile(path)) }).toEqual({ path, bytes: [] });
    }
  });

  it('never import Vitest or the test helpers, so tsx can load them', async () => {
    const harness = [
      ...(await captureSources()),
      join(here, 'task-fidelity', 'agent', 'scripted-provider.ts'),
    ];
    for (const path of harness) {
      const text = await readFile(path, 'utf8');
      expect({ path, vitest: /from 'vitest'|@yantra\/test-helpers/u.test(text) }).toEqual({
        path,
        vitest: false,
      });
    }
  });
});
