/// <reference lib="dom" />
/**
 * @no-llm Drshya gallery harness (spec TASK-003).
 *
 * Every gallery entry renders in light and dark, Glass and Solid, in real
 * Chrome under the app's own CSP. For each state it asserts: no CSP violation,
 * no request to another origin, no page error, no axe-core violation, and a
 * match against the visual baseline (required on Linux; elsewhere only when a
 * baseline exists, spec S6).
 *
 * Deliberately ungated: a missing Chrome fails with a remediation.
 */

import { PRIMITIVES, type Oklch } from '@yantra/ui';
import { GALLERY_ENTRIES } from '@yantra/ui/gallery';
import type { Browser } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchGalleryBrowser } from './drshya/browser.js';
import {
  ENTRY_SELECTOR,
  foreignRequests,
  openGallery,
  runAxe,
  stateName,
  stateSearch,
  type AxeViolation,
  type GallerySurfaces,
  type GalleryTheme,
  type PageEvidence,
} from './drshya/capture.js';
import { serveGallery, type GalleryServer } from './drshya/gallery-server.js';
import { compareToBaseline, defaultVisualOptions, hasBaseline } from './drshya/visual.js';

const THEMES: readonly GalleryTheme[] = ['light', 'dark'];
const SURFACES: readonly GallerySurfaces[] = ['glass', 'solid'];
const STATE_TIMEOUT = 60_000;

const visualOptions = defaultVisualOptions();
const pixelsRequired = process.platform === 'linux';

function fog(name: string): Oklch {
  const primitive = PRIMITIVES.find((candidate) => candidate.name === name);
  if (primitive === undefined) {
    throw new Error(`unknown primitive ${name}`);
  }
  return primitive.light;
}

/**
 * Parses a computed `oklch()` token. The build's CSS minifier rewrites
 * `oklch(0.125 0.007 255)` as `oklch(12.5% .007 255)`, so compare numbers.
 */
function parseOklch(value: string): Oklch {
  const match = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/u.exec(value);
  if (match === null) {
    throw new Error(`not an oklch() value: ${value}`);
  }
  const lightness = Number(match[1]);
  return {
    l: match[2] === '%' ? lightness / 100 : lightness,
    c: Number(match[3]),
    h: Number(match[4]),
  };
}

describe('@no-llm Drshya gallery', () => {
  let browser: Browser;
  let server: GalleryServer;

  beforeAll(async () => {
    server = await serveGallery();
    browser = await launchGalleryBrowser();
  }, STATE_TIMEOUT);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  for (const entry of GALLERY_ENTRIES) {
    for (const theme of THEMES) {
      for (const surfaces of SURFACES) {
        const state = { entry: entry.id, theme, surfaces };
        const name = stateName(state);

        describe(`${name}`, () => {
          let evidence: PageEvidence;
          let violations: AxeViolation[];
          let screenshot: Uint8Array;

          beforeAll(async () => {
            const opened = await openGallery(browser, server.origin, stateSearch(state));
            try {
              const element = await opened.page.$(ENTRY_SELECTOR);
              if (element === null) {
                throw new Error(`${name}: no ${ENTRY_SELECTOR} rendered`);
              }
              screenshot = await element.screenshot({ type: 'png' });
              // Evidence first: injecting axe must not be able to mask a violation.
              evidence = await opened.evidence();
              violations = await runAxe(opened.page);
            } finally {
              await opened.page.close();
            }
          }, STATE_TIMEOUT);

          it('loads under the CSP with no violation, page error or foreign request', () => {
            expect(evidence.cspViolations).toEqual([]);
            expect(evidence.pageErrors).toEqual([]);
            expect(foreignRequests(evidence, server.origin)).toEqual([]);
            expect(evidence.requests.length).toBeGreaterThan(0);
          });

          it('has no axe-core violations', () => {
            expect(violations).toEqual([]);
          });

          const comparePixels =
            pixelsRequired || visualOptions.update || hasBaseline(name, visualOptions);
          it.skipIf(!comparePixels)(
            `matches the visual baseline${comparePixels ? '' : ` (skipped: no ${process.platform} baseline; Linux CI is the pixel gate, spec S6)`}`,
            async () => {
              const result = await compareToBaseline(name, screenshot, visualOptions);
              if (result.status === 'missing') {
                throw new Error(
                  `No baseline at ${result.baselinePath}. The actual image is at ${result.actualPath}; ` +
                    'commit it as the baseline if it is correct (UPDATE_DRSHYA_BASELINES=1 writes baselines).',
                );
              }
              if (result.status === 'mismatch') {
                throw new Error(
                  `${name}: ${result.reason}. Actual: ${result.actualPath}` +
                    (result.diffPath === null ? '' : `, diff: ${result.diffPath}`),
                );
              }
              expect(['match', 'written']).toContain(result.status);
            },
            STATE_TIMEOUT,
          );
        });
      }
    }
  }

  describe('system theme', () => {
    const entry = GALLERY_ENTRIES[0]?.id ?? 'tokens-colors';

    async function backgroundToken(
      theme: 'system' | 'light',
      os: 'light' | 'dark',
    ): Promise<Oklch> {
      const opened = await openGallery(
        browser,
        server.origin,
        stateSearch({ entry, theme, surfaces: 'glass' }),
        { media: [{ name: 'prefers-color-scheme', value: os }] },
      );
      try {
        return parseOklch(
          await opened.page.$eval(ENTRY_SELECTOR, (element) =>
            getComputedStyle(element).getPropertyValue('--color-bg').trim(),
          ),
        );
      } finally {
        await opened.page.close();
      }
    }

    it(
      'follows a dark OS when data-theme is absent',
      async () => {
        expect(await backgroundToken('system', 'dark')).toEqual(fog('fog-99'));
      },
      STATE_TIMEOUT,
    );

    it(
      'follows a light OS when data-theme is absent',
      async () => {
        expect(await backgroundToken('system', 'light')).toEqual(fog('fog-05'));
      },
      STATE_TIMEOUT,
    );

    it(
      'keeps light values when data-theme="light" pins them under a dark OS',
      async () => {
        expect(await backgroundToken('light', 'dark')).toEqual(fog('fog-05'));
      },
      STATE_TIMEOUT,
    );
  });
});
