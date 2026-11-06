/**
 * Real Chrome for the Drshya gallery harness.
 *
 * Deliberately ungated, like the agent-browser and widget gauntlet suites:
 * only Chrome discovery depends on the environment, and a missing Chrome
 * fails the suite with a remediation rather than skipping it.
 */

import { detectChrome } from '@yantra/core';
import puppeteer, { type Browser } from 'puppeteer-core';

/** A fixed viewport so screenshots are comparable run to run. */
export const GALLERY_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 } as const;

export class GalleryBrowserUnavailableError extends Error {
  constructor() {
    super(
      'The Drshya gallery harness needs a local Chrome, and none was found. ' +
        'Install Google Chrome (stable), then re-run. Discovery uses @yantra/core detectChrome, ' +
        'the same as the other real-browser suites.',
    );
    this.name = 'GalleryBrowserUnavailableError';
  }
}

/** Launches headless Chrome with an sRGB color profile, so sampled pixels are exact. */
export async function launchGalleryBrowser(): Promise<Browser> {
  const chrome = detectChrome();
  if (chrome === null) {
    throw new GalleryBrowserUnavailableError();
  }
  return puppeteer.launch({
    executablePath: chrome.path,
    headless: true,
    defaultViewport: GALLERY_VIEWPORT,
    args: [
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      '--disable-lcd-text',
      '--hide-scrollbars',
    ],
  });
}
