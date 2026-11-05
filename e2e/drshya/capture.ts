/// <reference lib="dom" />
/**
 * Opens one gallery state in real Chrome and collects the evidence the
 * harness asserts on: every request URL, every CSP violation, page errors,
 * an element screenshot and the axe-core result.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { AxeResults, ElementContext, RunOptions } from 'axe-core';
import type { Browser, Page } from 'puppeteer-core';

declare global {
  interface Window {
    __drshyaCspViolations?: { blockedURI: string; violatedDirective: string }[];
    axe?: { run(context: ElementContext, options: RunOptions): Promise<AxeResults> };
  }
}

/** axe-core's source, injected with `Runtime.evaluate`, which CSP does not govern. */
const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

export type GalleryTheme = 'light' | 'dark';
export type GallerySurfaces = 'glass' | 'solid';

export interface GalleryState {
  readonly entry: string;
  readonly theme: GalleryTheme | 'system';
  readonly surfaces: GallerySurfaces;
}

export interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly targets: readonly string[];
}

export interface PageEvidence {
  readonly requests: readonly string[];
  readonly cspViolations: readonly { blockedURI: string; violatedDirective: string }[];
  readonly pageErrors: readonly string[];
}

export const ENTRY_SELECTOR = '[data-gallery-entry]';

/** `button--dark--glass`: the baseline file name for a state. */
export function stateName(state: GalleryState): string {
  return `${state.entry}--${state.theme}--${state.surfaces}`;
}

export function stateSearch(state: GalleryState): string {
  return `?${new URLSearchParams({
    entry: state.entry,
    theme: state.theme,
    surfaces: state.surfaces,
  }).toString()}`;
}

export interface OpenOptions {
  /** Media features to emulate before navigation; reduced motion is always on. */
  readonly media?: readonly { name: string; value: string }[];
}

export interface OpenedPage {
  readonly page: Page;
  /** Evidence collected so far; read it after the assertions' last action. */
  evidence(): Promise<PageEvidence>;
}

/**
 * Opens a gallery URL in a fresh page with the collectors installed before the
 * first navigation, and waits until the gallery reports fonts ready.
 */
export async function openGallery(
  browser: Browser,
  origin: string,
  search: string,
  options: OpenOptions = {},
): Promise<OpenedPage> {
  const page = await browser.newPage();
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error instanceof Error ? error.message : String(error));
  });
  await page.evaluateOnNewDocument(() => {
    window.__drshyaCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__drshyaCspViolations?.push({
        blockedURI: event.blockedURI,
        violatedDirective: event.violatedDirective,
      });
    });
  });
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
    ...(options.media ?? []),
  ]);
  await page.goto(`${origin}/index.html${search}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-gallery-ready]', { timeout: 15_000 });

  return {
    page,
    evidence: async () => ({
      requests: [...requests],
      pageErrors: [...pageErrors],
      cspViolations: await page.evaluate(() => [...(window.__drshyaCspViolations ?? [])]),
    }),
  };
}

/** Runs axe-core on one element and returns its violations, summarized. */
export async function runAxe(
  page: Page,
  selector: string = ENTRY_SELECTOR,
): Promise<AxeViolation[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (target) => {
    const axe = window.axe;
    const element = document.querySelector(target);
    if (axe === undefined || element === null) {
      throw new Error(`axe-core or ${target} is missing`);
    }
    const result = await axe.run(element, { resultTypes: ['violations'] });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  }, selector);
}

/** Request URLs whose origin is not the gallery server's (data: URIs included). */
export function foreignRequests(evidence: PageEvidence, origin: string): string[] {
  return evidence.requests.filter((url) => {
    try {
      return new URL(url).origin !== origin;
    } catch {
      return true;
    }
  });
}
