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

import {
  BLACK,
  DRSHYA_TOKENS,
  GLASS_SPEC,
  PRIMITIVES,
  WHITE,
  compositeOver,
  resolveGlassAlpha,
  resolveRgb,
  type Oklch,
  type Rgb,
} from '@yantra/ui';
import { GALLERY_ENTRIES } from '@yantra/ui/gallery';
import { PNG } from 'pngjs';
import type { Browser, Page } from 'puppeteer-core';
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

  describe('glass and solid surfaces', () => {
    const WINDOW = 64;
    const INSET = 16;
    const CHANNEL_TOLERANCE = 3 / 255;

    /** Mean RGB (0..1) of a 64 px window in the empty lower right of a panel. */
    async function sampleTint(page: Page, backdrop: string): Promise<Rgb> {
      const panel = await page.$(`[data-glass-backdrop="${backdrop}"] [data-glass-panel]`);
      const box = await panel?.boundingBox();
      if (box === null || box === undefined) {
        throw new Error(`no glass panel over ${backdrop}`);
      }
      const png = PNG.sync.read(
        Buffer.from(
          await page.screenshot({
            type: 'png',
            clip: {
              x: Math.round(box.x + box.width - INSET - WINDOW),
              y: Math.round(box.y + box.height - INSET - WINDOW),
              width: WINDOW,
              height: WINDOW,
            },
          }),
        ),
      );
      const sums = [0, 0, 0];
      for (let pixel = 0; pixel < WINDOW * WINDOW; pixel += 1) {
        for (const channel of [0, 1, 2] as const) {
          sums[channel] = (sums[channel] ?? 0) + (png.data[pixel * 4 + channel] ?? 0);
        }
      }
      const mean = (channel: 0 | 1 | 2) => (sums[channel] ?? 0) / (WINDOW * WINDOW * 255);
      return [mean(0), mean(1), mean(2)];
    }

    async function surfaceStyle(
      surfaces: 'glass' | 'solid',
      media: readonly { name: string; value: string }[] = [],
    ): Promise<{ backdropFilter: string; background: string; surface: string }> {
      const opened = await openGallery(
        browser,
        server.origin,
        stateSearch({ entry: 'surfaces-glass', theme: 'light', surfaces }),
        { media },
      );
      try {
        return await opened.page.$eval('[data-glass-panel]', (panel) => {
          const probe = document.createElement('div');
          probe.style.setProperty('background-color', 'var(--color-surface)');
          panel.append(probe);
          const surface = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const style = getComputedStyle(panel);
          return {
            backdropFilter: style.backdropFilter,
            background: style.backgroundColor,
            surface,
          };
        });
      } finally {
        await opened.page.close();
      }
    }

    for (const theme of THEMES) {
      it(
        `composites the ${theme} tint exactly as the S3 model predicts, over black and white`,
        async () => {
          const opened = await openGallery(
            browser,
            server.origin,
            stateSearch({ entry: 'surfaces-glass', theme, surfaces: 'glass' }),
          );
          try {
            const tint = resolveRgb(DRSHYA_TOKENS, 'glass-tint', theme);
            const alpha = resolveGlassAlpha(DRSHYA_TOKENS, theme);
            const noise = GLASS_SPEC.noiseAlpha;
            const offBy: string[] = [];
            for (const [backdrop, color] of [
              ['black', BLACK],
              ['white', WHITE],
            ] as const) {
              const base = compositeOver(tint, alpha, color);
              // The noise tile is half black, half white: over one full period
              // its mean shifts the base by noise * (0.5 - base).
              const expected = base.map((value) => value + noise * (0.5 - value));
              const actual = await sampleTint(opened.page, backdrop);
              actual.forEach((value, channel) => {
                const delta = Math.abs(value - (expected[channel] ?? Number.NaN));
                if (delta > CHANNEL_TOLERANCE) {
                  offBy.push(
                    `${backdrop} channel ${String(channel)}: ${(delta * 255).toFixed(2)}/255`,
                  );
                }
              });
            }
            expect(offBy).toEqual([]);
          } finally {
            await opened.page.close();
          }
        },
        STATE_TIMEOUT,
      );
    }

    it(
      'renders glass translucent with a backdrop filter in Glass mode',
      async () => {
        const style = await surfaceStyle('glass');

        expect(style.backdropFilter).not.toBe('none');
        expect(style.background).not.toBe(style.surface);
      },
      STATE_TIMEOUT,
    );

    it(
      'swaps glass for the opaque surface under data-surfaces="solid"',
      async () => {
        const style = await surfaceStyle('solid');

        expect(style.backdropFilter).toBe('none');
        expect(style.background).toBe(style.surface);
      },
      STATE_TIMEOUT,
    );

    it(
      'swaps glass for the opaque surface when the OS asks for reduced transparency',
      async () => {
        const style = await surfaceStyle('glass', [
          { name: 'prefers-reduced-transparency', value: 'reduce' },
        ]);

        expect(style.backdropFilter).toBe('none');
        expect(style.background).toBe(style.surface);
      },
      STATE_TIMEOUT,
    );
  });

  describe('type, shape and motion', () => {
    interface TypeEvidence {
      readonly loadedFamilies: string[];
      readonly engineFamily: string;
      readonly engineStretch: string;
      readonly loopIterations: string;
      readonly bannedRadius: string;
      readonly frameRadius: string;
    }

    let evidence: TypeEvidence;
    let pageEvidence: PageEvidence;

    beforeAll(async () => {
      const opened = await openGallery(
        browser,
        server.origin,
        stateSearch({ entry: 'tokens-type-shape-motion', theme: 'light', surfaces: 'glass' }),
      );
      try {
        evidence = await opened.page.evaluate(() => {
          const style = (selector: string) => {
            const element = document.querySelector(selector);
            if (element === null) {
              throw new Error(`missing ${selector}`);
            }
            return getComputedStyle(element);
          };
          return {
            loadedFamilies: [...document.fonts]
              .filter((face) => face.status === 'loaded')
              .map((face) => face.family.replaceAll('"', '')),
            engineFamily: style('[data-voice="engine"]').fontFamily,
            engineStretch: style('[data-voice="engine"]').fontStretch,
            loopIterations: style('[data-motion-loop]').animationIterationCount,
            bannedRadius: style('[data-banned-radius]').borderTopLeftRadius,
            frameRadius: style('.rounded-frame').borderTopLeftRadius,
          };
        });
        pageEvidence = await opened.evidence();
      } finally {
        await opened.page.close();
      }
    }, STATE_TIMEOUT);

    it('loads both self-hosted families from the gallery origin', () => {
      expect(new Set(evidence.loadedFamilies)).toEqual(
        new Set(['Archivo Variable', 'Martian Mono Variable']),
      );
      const fontRequests = pageEvidence.requests.filter((url) => url.endsWith('.woff2'));
      expect(fontRequests.length).toBeGreaterThan(0);
      expect(foreignRequests(pageEvidence, server.origin)).toEqual([]);
    });

    it('sets the engine voice in Martian Mono at 87.5% width', () => {
      expect(evidence.engineFamily.startsWith('"Martian Mono Variable"')).toBe(true);
      expect(evidence.engineStretch).toBe('87.5%');
    });

    it('runs a loop once under reduced motion', () => {
      expect(evidence.loopIterations).toBe('1');
    });

    it('compiles rounded-2xl to nothing while Drshya radii apply', () => {
      expect(evidence.bannedRadius).toBe('0px');
      expect(evidence.frameRadius).toBe('14px');
    });
  });

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
