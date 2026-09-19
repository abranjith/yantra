/**
 * Typed browser startup failures survive the agent tool boundary.
 *
 * Before this table every one of these causes arrived at the model as
 * `TOOL_EXECUTION_FAILED`, retryable, with the remediation the core error was
 * carrying thrown away — so a run with no browser installed spent its budget
 * retrying a call that could never work. The tests here are built from the
 * real exported error classes on purpose: the mapper classifies by
 * `instanceof`, so a structural double would pass a test the production path
 * would fail.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserCompatibilityError,
  BrowserInstallOfferDeclinedError,
  BrowserLaunchError,
  BrowserManagedInstallError,
  BrowserProcessError,
  BrowserResolutionError,
  ChromeNotFoundError,
  ManagedCoordinationError,
} from '@yantra/core';
import { assertRuntimeEventIsSafe } from '@yantra/test-helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { browserNavigateSpec } from '../../../../src/adapters/pi/tools/browser-navigate.js';
import {
  SUPPORTED_BROWSER_STARTUP_ERRORS,
  mapBrowserStartupError,
} from '../../../../src/adapters/pi/tools/browser-startup-errors.js';
import { webFetchSpec } from '../../../../src/adapters/pi/tools/web-fetch.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import { UrlProvenance } from '../../../../src/runtime/url-provenance.js';

import { buildServices } from './test-support.js';

/** Planted in every field a startup projection must never reach for. */
export const CANARIES = Object.freeze({
  stderr: 'CANARY-STDERR-6f1d',
  arg: '--canary=CANARY-ARGV-2c88',
  detail: 'CANARY-DETAIL-a41e',
  profilePath: '/home/canary/.yantra/CANARY-PROFILE',
  executablePath: '/home/canary/CANARY-EXEC/chrome',
  pageUrl: 'https://canary.example.com/CANARY-URL',
});

/** One instance of every class the mapper declares it is responsible for. */
function supportedErrors(): Readonly<Record<string, Error>> {
  return {
    BrowserResolutionError: new BrowserResolutionError({
      code: 'invalid-executable',
      message: `The browser at ${CANARIES.executablePath} is unusable.`,
      requestedSelection: { source: 'system', executablePath: CANARIES.executablePath },
      remediation: 'Select a working browser with `yantra browser use`.',
    }),
    ChromeNotFoundError: new ChromeNotFoundError({
      os: 'linux',
      probed: [CANARIES.executablePath],
    }),
    BrowserCompatibilityError: new BrowserCompatibilityError({
      failureClass: 'capability-failure',
      profile: 'automation',
      executablePath: CANARIES.executablePath,
      version: '121.0.0.0',
      capabilities: [
        { capability: 'pipe-version', status: 'passed', reason: null },
        { capability: 'click-replace', status: 'failed', reason: CANARIES.detail },
        { capability: 'frame-token', status: 'failed', reason: CANARIES.detail },
      ],
      remediation: `Install a current Chrome, not the one at ${CANARIES.executablePath}.`,
    }),
    ManagedCoordinationError: new ManagedCoordinationError({
      reason: 'active-use',
      detail: CANARIES.detail,
      remediation: 'Wait for the other run to finish.',
    }),
    BrowserLaunchError: new BrowserLaunchError({
      phase: 'connect',
      lastStderr: CANARIES.stderr,
      args: [CANARIES.arg, `--user-data-dir=${CANARIES.profilePath}`],
    }),
    BrowserProcessError: new BrowserProcessError({
      phase: 'settle',
      detail: CANARIES.detail,
      exitProven: false,
    }),
    BrowserInstallOfferDeclinedError: new BrowserInstallOfferDeclinedError(),
    BrowserManagedInstallError: new BrowserManagedInstallError({
      code: 'network-failure',
      phase: 'downloading',
      detail: CANARIES.detail,
      remediation: 'Check the network and run `yantra browser install` again.',
      retainedOrphan: null,
    }),
  };
}

const EXPECTED_CODES: Readonly<Record<string, string>> = {
  BrowserResolutionError: 'BROWSER_RESOLUTION_FAILED',
  ChromeNotFoundError: 'BROWSER_RESOLUTION_FAILED',
  BrowserCompatibilityError: 'BROWSER_COMPATIBILITY_FAILED',
  ManagedCoordinationError: 'BROWSER_COORDINATION_FAILED',
  BrowserLaunchError: 'BROWSER_LAUNCH_FAILED',
  BrowserProcessError: 'BROWSER_PROCESS_FAILED',
  BrowserInstallOfferDeclinedError: 'BROWSER_INSTALL_DECLINED',
  BrowserManagedInstallError: 'BROWSER_INSTALL_FAILED',
};

describe('@no-llm browser startup error mapper', () => {
  it('covers exactly the classes it declares support for', () => {
    const errors = supportedErrors();

    // Mechanical, not by reading the branches: adding a name to the declared
    // table without a branch, or a branch without a name, fails here.
    expect(Object.keys(errors).sort()).toEqual([...SUPPORTED_BROWSER_STARTUP_ERRORS].sort());
    const unmapped = Object.entries(errors)
      .filter(([, error]) => mapBrowserStartupError(error) === null)
      .map(([name]) => name);
    expect(unmapped).toEqual([]);
    for (const [name, error] of Object.entries(errors)) expect(error.name).toBe(name);
  });

  it.each(Object.keys(EXPECTED_CODES))('maps %s to its stable non-retryable code', (name) => {
    const mapped = mapBrowserStartupError(supportedErrors()[name]!);

    expect(mapped).not.toBeNull();
    expect(mapped!.errorCode).toBe(EXPECTED_CODES[name]);
    // Nothing in this feature repairs a browser mid-run, so an identical retry
    // cannot succeed and must not be advertised as if it could.
    expect(mapped!.retryable).toBe(false);
    expect(mapped!.errorCode).not.toBe('TOOL_EXECUTION_FAILED');
  });

  it('never projects an argument, stderr, detail, or path into the result', () => {
    for (const [name, error] of Object.entries(supportedErrors())) {
      const mapped = mapBrowserStartupError(error)!;
      const payload = { message: mapped.message, details: mapped.details };
      assertRuntimeEventIsSafe(payload, Object.values(CANARIES), `${name} projection`);
    }
  });

  it('carries the exit-class semantics each cause already had', () => {
    const detailOf = (name: string): Record<string, unknown> =>
      mapBrowserStartupError(supportedErrors()[name]!)!.details as Record<string, unknown>;

    expect(detailOf('BrowserResolutionError')).toMatchObject({
      failure_class: 'environment',
      resolution_code: 'invalid-executable',
      selection_source: 'system',
    });
    expect(detailOf('BrowserCompatibilityError')).toMatchObject({
      failure_class: 'environment',
      compatibility_failure_class: 'capability-failure',
      probe_profile: 'automation',
      browser_version: '121.0.0.0',
      failed_capabilities: ['click-replace', 'frame-token'],
    });
    expect(detailOf('ManagedCoordinationError')).toMatchObject({
      failure_class: 'environment',
      coordination_reason: 'active-use',
    });
    expect(detailOf('BrowserLaunchError')).toMatchObject({
      failure_class: 'environment',
      launch_phase: 'connect',
    });
    expect(detailOf('BrowserProcessError')).toMatchObject({
      failure_class: 'environment',
      process_phase: 'settle',
      exit_proven: false,
    });
    expect(detailOf('BrowserManagedInstallError')).toMatchObject({
      failure_class: 'environment',
      install_code: 'network-failure',
      install_phase: 'downloading',
    });
  });

  it('marks a declined install offer as a user handoff, not an environment fault', () => {
    const mapped = mapBrowserStartupError(new BrowserInstallOfferDeclinedError())!;

    expect(mapped.details).toMatchObject({ failure_class: 'user-handoff', handoff: true });
    // The user made a decision; the message must not read as a malfunction and
    // must not send the agent back to ask again.
    expect(mapped.message).toContain('declined');
    expect(mapped.message).toContain('result_publish');
  });

  it('gives every cause its own message, each pointing at result_publish', () => {
    const messages = Object.keys(EXPECTED_CODES).map(
      (name) => mapBrowserStartupError(supportedErrors()[name]!)!.message,
    );

    // Two failures that read identically are two failures nobody can tell
    // apart; the resolution/compatibility pair is where that matters most.
    expect(new Set(messages).size).toBe(new Set(Object.values(EXPECTED_CODES)).size);
    for (const message of messages) {
      expect(message).toContain('result_publish');
      // The agent has no browser-management tool, so the advice must never
      // read as one it can invoke itself.
      expect(message).toMatch(/[Tt]ell the user/u);
    }
  });

  it('returns null for anything outside its table', () => {
    const outsiders: unknown[] = [
      new Error('Navigation timeout of 30000 ms exceeded'),
      new TypeError('Cannot read properties of null'),
      // A post-launch session crash is handled in-run and is not a startup
      // refusal; mapping it here would change existing behavior.
      Object.assign(new Error('session crashed'), { name: 'BrowserCrashedError' }),
      // A structural look-alike is not the real class.
      Object.assign(new Error('missing'), { name: 'BrowserResolutionError', code: 'missing' }),
      null,
      undefined,
      'a string',
    ];

    for (const outsider of outsiders) {
      expect(mapBrowserStartupError(outsider)).toBeNull();
    }
  });
});

describe('@no-llm startup failures at the browser-backed tool boundaries', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-startup-boundary-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  /** `web_fetch` with a fetcher that fails the way the browser fallback does. */
  async function throughWebFetch(error: unknown) {
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: {
          fetch: () => Promise.reject(error),
        },
      },
    });
    const tool = wrapTool(webFetchSpec(services), services);
    return tool.execute({ url: CANARIES.pageUrl }, undefined);
  }

  /** `browser_navigate` with a controller whose lazy first launch refuses. */
  async function throughBrowserNavigate(error: unknown) {
    const provenance = new UrlProvenance();
    provenance.seed({ allowedHosts: ['canary.example.com'] });
    const services = buildServices({
      runDir,
      urlProvenance: provenance,
      domain: {
        browser: {
          controller: {
            // The middleware opens a tool-call scope on the controller before
            // the tool runs, so the double needs it even though nothing here
            // observes it.
            beginToolCall: () => undefined,
            navigate: () => Promise.reject(error),
          } as never,
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 16 * 1024,
        },
      },
    });
    const tool = wrapTool(browserNavigateSpec(services), services);
    return tool.execute({ url: CANARIES.pageUrl }, undefined);
  }

  it.each(Object.keys(EXPECTED_CODES))(
    'reports %s under its stable code through web_fetch',
    async (name) => {
      const result = await throughWebFetch(supportedErrors()[name]!);

      expect(result.status).toBe('error');
      expect(result.error_code).toBe(EXPECTED_CODES[name]);
      expect(result.retryable).toBe(false);
      expect(result.modelText).not.toContain('TOOL_EXECUTION_FAILED');
      assertRuntimeEventIsSafe(
        { text: result.modelText, details: result.details },
        Object.values(CANARIES),
        `${name} via web_fetch`,
      );
    },
  );

  it.each(Object.keys(EXPECTED_CODES))(
    'reports %s under its stable code through browser_navigate',
    async (name) => {
      const result = await throughBrowserNavigate(supportedErrors()[name]!);

      expect(result.status).toBe('error');
      expect(result.error_code).toBe(EXPECTED_CODES[name]);
      expect(result.retryable).toBe(false);
      expect(result.modelText).not.toContain('TOOL_EXECUTION_FAILED');
      assertRuntimeEventIsSafe(
        { text: result.modelText, details: result.details },
        Object.values(CANARIES),
        `${name} via browser_navigate`,
      );
    },
  );

  it('still genericizes an ordinary site or Puppeteer fault at both boundaries', async () => {
    const siteFault = new Error(
      `Navigation to ${CANARIES.pageUrl} timed out after 30000ms: ${CANARIES.detail}`,
    );

    const fetched = await throughWebFetch(siteFault);
    const navigated = await throughBrowserNavigate(siteFault);

    for (const result of [fetched, navigated]) {
      expect(result.status).toBe('error');
      expect(result.error_code).toBe('TOOL_EXECUTION_FAILED');
      // The generic result says nothing about the page, by design.
      expect(result.modelText).not.toContain(CANARIES.pageUrl);
      expect(result.modelText).not.toContain(CANARIES.detail);
    }
  });
});
