import type { ChromeInstall } from './types.js';

const DEFAULT_LOCALE = 'en-US';
const SAFE_LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export interface UserSimulationEnvironment {
  /** Host platform used to keep the desktop User-Agent internally consistent. */
  readonly platform?: NodeJS.Platform;
  /** Browser UI locale; defaults to the Node process's resolved host locale. */
  readonly locale?: string;
}

/**
 * Builds the desktop User-Agent token emitted by the installed Chrome channel.
 *
 * Chrome's reduced desktop UA intentionally freezes the OS version token, so
 * these values match current Chrome behavior while the browser's detected
 * major remains authoritative. Keeping the host platform aligned avoids the
 * old Windows-UA-on-macOS/Linux mismatch.
 */
export function buildDesktopChromeUserAgent(
  chromeMajor: number,
  platform: NodeJS.Platform = process.platform,
): string {
  const platformToken =
    platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return (
    `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`
  );
}

/**
 * Shared launch compatibility for user-initiated browser work.
 *
 * This removes the two most obvious headless-only surfaces while retaining
 * stock Puppeteer, system Chrome, normal CDP input events, and Yantra's honest
 * CAPTCHA/anomaly handoff. It deliberately does not inject scripts, forge
 * plugins/canvas/WebGL, solve challenges, or otherwise enter a stealth arms
 * race. Applied by the core launcher so agentic, search-scrape, deterministic
 * replay, and browser-fetch paths cannot drift apart.
 */
export function buildUserSimulationArgs(
  chrome: ChromeInstall,
  environment: UserSimulationEnvironment = {},
): readonly string[] {
  const locale = resolveLocale(environment.locale);
  return [
    `--user-agent=${buildDesktopChromeUserAgent(
      chrome.majorVersion,
      environment.platform ?? process.platform,
    )}`,
    '--disable-blink-features=AutomationControlled',
    `--lang=${locale}`,
  ];
}

function resolveLocale(locale: string | undefined): string {
  const detected = locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return SAFE_LOCALE_RE.test(detected) ? detected : DEFAULT_LOCALE;
}
