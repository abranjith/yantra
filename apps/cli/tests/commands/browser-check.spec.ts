/**
 * `yantra browser check` is a fresh local compatibility diagnosis.
 *
 * The invariants here are the ones that would make it a lie: it must use the
 * *same* probe implementation the resolver uses (asserted by spying on the
 * instance, since an outer decorator cannot see internal `this.method()`
 * calls), it must pass `fresh: true` so a cached success cannot short-circuit
 * it, and it must never fetch update metadata or mutate the selection.
 *
 * `capability-checked` is treated as normal operation, not a warning: current
 * Chrome Stable is ahead of the tested pairing and normally stays there, so that
 * is the primary fixture and the matching pairing is secondary.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserResolutionError,
  LocalBrowserCompatibilityService,
  requiredCapabilities,
  type BrowserResolution,
  type BrowserResolutionErrorCode,
  type BrowserRuntimeServices,
  type BrowserSelection,
  type CapabilityEvidence,
  type CompatibilityCheckOptions,
  type CompatibilityResult,
  type ProbeFailureClass,
  type ProbeProfile,
  type ResolvedBrowserInstallation,
} from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBrowserCommand } from '../../src/commands/browser.js';

function sink() {
  let value = '';
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        value += String(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
    text: () => value,
  };
}

/** Newer than the tested pairing — the steady state, so the primary fixture. */
const NEWER = '153.0.8010.36';
const TESTED = '152.0.7977.75';

function installation(
  overrides: Partial<ResolvedBrowserInstallation> = {},
): ResolvedBrowserInstallation {
  return {
    canonicalPath: '/opt/google/chrome/chrome',
    version: NEWER,
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: '1:2:3:4',
    ownership: 'external',
    requestedSelection: { source: 'auto', executablePath: null },
    selectionOrigin: 'default',
    selectionReason: 'system-discovery',
    channel: 'stable',
    managedIdentity: null,
    ...overrides,
  };
}

function allPassed(profile: ProbeProfile): readonly CapabilityEvidence[] {
  return requiredCapabilities(profile).map((row) => ({
    capability: row.id,
    status: 'passed' as const,
    reason: null,
  }));
}

function result(
  target: ResolvedBrowserInstallation,
  profile: ProbeProfile,
  verdict: CompatibilityResult['verdict'],
  capabilities?: readonly CapabilityEvidence[],
): CompatibilityResult {
  return {
    schemaVersion: 1,
    identity: target,
    driverVersion: '25.10.0',
    testedBuild: TESTED,
    probeRevision: 1,
    capabilityTableHash: 'hash',
    profile,
    checkedAt: '2026-09-14T00:00:00.000Z',
    capabilities: capabilities ?? allPassed(profile),
    verdict,
  };
}

interface Harness {
  readonly services: BrowserRuntimeServices;
  readonly compatibility: LocalBrowserCompatibilityService;
  readonly checkCalls: CompatibilityCheckOptions[];
  readonly resolveCalls: (BrowserSelection | undefined)[];
  readonly releases: () => { readonly profiles: number; readonly shutdowns: number };
}

function harness(
  options: {
    readonly resolution?: BrowserResolution;
    readonly resultFor?: (
      target: ResolvedBrowserInstallation,
      profile: ProbeProfile,
    ) => CompatibilityResult;
  } = {},
): Harness {
  const checkCalls: CompatibilityCheckOptions[] = [];
  const resolveCalls: (BrowserSelection | undefined)[] = [];
  let profiles = 0;
  let shutdowns = 0;

  // A real service instance, so spies observe exactly what the command calls.
  const compatibility = new LocalBrowserCompatibilityService();
  const target =
    options.resolution?.status === 'resolved' ? options.resolution.installation : installation();
  vi.spyOn(compatibility, 'check').mockImplementation((_installation, checkOptions) => {
    checkCalls.push(checkOptions);
    profiles += 1;
    shutdowns += 1;
    return Promise.resolve(
      options.resultFor?.(target, checkOptions.profile) ??
        result(target, checkOptions.profile, {
          status: 'passed',
          pairing: 'capability-checked',
        }),
    );
  });

  const services: BrowserRuntimeServices = {
    resolver: {
      resolve: (selection) => {
        resolveCalls.push(selection);
        return Promise.resolve(
          options.resolution ?? { status: 'resolved', installation: installation() },
        );
      },
    },
    compatibility,
    coordinator: {
      reserveUse: () => Promise.reject(new Error('the probe owns its own reservation')),
      claimMutation: vi.fn(),
      hasActiveUse: () => Promise.resolve(false),
    },
    managedState: {
      readReady: () => Promise.resolve({ status: 'absent' }),
      readInventory: () => Promise.resolve({ ready: { status: 'absent' }, orphans: [] }),
    },
  };

  return {
    services,
    compatibility,
    checkCalls,
    resolveCalls,
    releases: () => ({ profiles, shutdowns }),
  };
}

/** A real {@link BrowserResolutionError}; see the note in `browser-use.spec.ts`. */
function resolutionError(code: BrowserResolutionErrorCode, message: string) {
  return new BrowserResolutionError({
    code,
    message,
    requestedSelection: { source: 'auto', executablePath: null },
    remediation: 'Run `yantra browser install`.',
  });
}

async function runCheck(h: Harness, args: readonly string[]) {
  const stdout = sink();
  const stderr = sink();
  const outcome = await makeBrowserCommand({
    services: h.services,
    stdout: stdout.stream,
    stderr: stderr.stream,
  })
    .parseAsync(['check', ...args], { from: 'user' })
    .then(
      () => ({ exitCode: 0 }),
      (error: unknown) => ({ exitCode: (error as { exitCode?: number }).exitCode ?? -1 }),
    );
  return { ...outcome, stdout: stdout.text(), stderr: stderr.text() };
}

describe('@no-llm browser check command', () => {
  let home: string;
  const savedHome = process.env.YANTRA_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'yantra-browser-check-'));
    process.env.YANTRA_HOME = home;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it('uses the same probe instance the resolver path uses', async () => {
    const h = harness();
    const spy = vi.spyOn(h.compatibility, 'check');

    await runCheck(h, ['--json']);

    // Spied on the instance rather than counted through an outer wrapper.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('always asks for a fresh probe, for both capability profiles', async () => {
    const h = harness();
    await runCheck(h, ['--json']);
    expect(h.checkCalls.map((call) => call.profile)).toEqual(['automation', 'recorder']);
    expect(h.checkCalls.every((call) => call.fresh)).toBe(true);
  });

  it('does not short-circuit on a cached success', async () => {
    const h = harness();
    // `readCached` would report evidence, but `check` must still run: a replay
    // of yesterday's answer is not a diagnosis.
    const cached = vi.spyOn(h.compatibility, 'readCached');
    await runCheck(h, ['--json']);
    expect(cached).not.toHaveBeenCalled();
    expect(h.checkCalls).toHaveLength(2);
  });

  it('reports a build newer than the tested pairing as capability-checked, without warning styling', async () => {
    const h = harness();
    const run = await runCheck(h, []);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('capability-checked');
    expect(run.stdout).toContain(NEWER);
    expect(run.stdout.toLowerCase()).not.toContain('warning');
    expect(run.stderr).toBe('');
  });

  it('reports the matching pairing as tested', async () => {
    const target = installation({ version: TESTED, majorVersion: 152 });
    const h = harness({
      resolution: { status: 'resolved', installation: target },
      resultFor: (_t, profile) => result(target, profile, { status: 'passed', pairing: 'tested' }),
    });

    const run = await runCheck(h, []);
    expect(run.stdout).toContain('tested pairing');
  });

  it('renders each capability row with the descriptor’s own justification', async () => {
    const h = harness();
    const run = await runCheck(h, []);

    // Rendered verbatim from the declared table: the CLI keeps no second copy.
    for (const row of requiredCapabilities('recorder')) {
      expect(run.stdout).toContain(row.id);
      expect(run.stdout).toContain(row.why);
    }
  });

  describe('failures', () => {
    const CLASSES: readonly [ProbeFailureClass, string][] = [
      [
        'missing-runtime-libraries',
        'Install the packages this Chrome build needs: libnss3, libatk-1.0-0, libgbm1.',
      ],
      ['capability-failure', 'This browser does not support popup-session.'],
      ['launch-environment', 'Install a current Chrome or Chromium.'],
    ];

    it.each(CLASSES)(
      'renders %s with its own remediation and exits 3',
      async (failureClass, remediation) => {
        const target = installation();
        const h = harness({
          resolution: { status: 'resolved', installation: target },
          resultFor: (_t, profile) =>
            result(target, profile, { status: 'failed', failureClass, remediation }),
        });

        const run = await runCheck(h, []);

        expect(run.exitCode).toBe(3);
        expect(run.stdout).toContain(failureClass);
        expect(run.stderr).toContain(remediation);
      },
    );

    it('gives each failure class a distinct remediation', async () => {
      const messages: string[] = [];
      for (const [failureClass, remediation] of CLASSES) {
        const target = installation();
        const h = harness({
          resolution: { status: 'resolved', installation: target },
          resultFor: (_t, profile) =>
            result(target, profile, { status: 'failed', failureClass, remediation }),
        });
        messages.push((await runCheck(h, [])).stderr);
      }
      expect(new Set(messages).size).toBe(messages.length);
    });

    it('names exactly the failing rows and the prerequisite a not-run row waited on', async () => {
      const target = installation();
      const h = harness({
        resolution: { status: 'resolved', installation: target },
        resultFor: (_t, profile) =>
          result(
            target,
            profile,
            {
              status: 'failed',
              failureClass: 'capability-failure',
              remediation: 'This browser does not support dom-handles.',
            },
            [
              { capability: 'pipe-version', status: 'passed', reason: null },
              { capability: 'runtime-evaluate', status: 'passed', reason: null },
              {
                capability: 'dom-handles',
                status: 'failed',
                reason: 'handles were never released',
              },
              {
                capability: 'click-replace',
                status: 'not-run',
                reason: 'prerequisite dom-handles failed',
              },
            ],
          ),
      });

      const run = await runCheck(h, ['--json']);
      const payload = JSON.parse(run.stdout) as {
        profiles: readonly { capabilities: readonly CapabilityEvidence[] }[];
      };
      const rows = payload.profiles[0]!.capabilities;

      expect(rows.filter((row) => row.status === 'failed').map((row) => row.capability)).toEqual([
        'dom-handles',
      ]);
      expect(rows.find((row) => row.status === 'not-run')?.reason).toContain('dom-handles');
      // A version mismatch is never implied as the cause of a capability failure.
      expect(run.stderr).not.toMatch(/version|pairing/iu);
    });

    it('fails a broken explicit selection with the resolver’s remediation', async () => {
      const h = harness({
        resolution: {
          status: 'unavailable',
          error: resolutionError('managed-state-invalid', 'The ready pointer is malformed.'),
        },
      });

      const run = await runCheck(h, ['--browser', 'managed']);

      expect(run.exitCode).toBe(3);
      expect(run.stderr).toContain('yantra browser install');
      // It must not quietly check something else instead.
      expect(h.checkCalls).toHaveLength(0);
    });

    it('rejects an invalid flag pair as validation, not environment', async () => {
      const h = harness();
      const run = await runCheck(h, ['--browser', 'managed', '--browser-path', '/opt/chrome']);
      expect(run.exitCode).toBe(1);
      expect(h.resolveCalls).toHaveLength(0);
    });
  });

  describe('selection', () => {
    it('overrides with --browser-path without touching config', async () => {
      const configPath = join(home, 'config.yaml');
      const original = 'browser:\n  source: auto\n  executable_path: null\n';
      await writeFile(configPath, original);

      const h = harness();
      await runCheck(h, ['--browser-path', '/opt/other/chrome', '--json']);

      expect(h.resolveCalls).toEqual([{ source: 'system', executablePath: '/opt/other/chrome' }]);
      expect(await readFile(configPath, 'utf8')).toBe(original);
    });

    it('falls through to the configured selection when no flag is given', async () => {
      const h = harness();
      await runCheck(h, ['--json']);
      expect(h.resolveCalls).toEqual([undefined]);
    });

    it('reports the selection origin in the report', async () => {
      const h = harness({
        resolution: {
          status: 'resolved',
          installation: installation({ selectionOrigin: 'config' }),
        },
      });
      const run = await runCheck(h, ['--json']);
      expect(JSON.parse(run.stdout)).toMatchObject({
        browser: { selectionOrigin: 'config' },
      });
    });
  });

  it('emits exactly one JSON envelope carrying the report', async () => {
    const h = harness();
    const run = await runCheck(h, ['--json']);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: 'browser_check',
      driverVersion: '25.10.0',
      testedBuild: TESTED,
      probeRevision: 1,
      browser: { version: NEWER, ownership: 'external' },
    });
  });

  it('fetches no update metadata and downloads nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const h = harness();
    await runCheck(h, ['--json']);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('runs one probe per required profile on the failure path too', async () => {
    // The probe owns closing its synthetic browser, profile, and reservation on
    // success *and* failure; the command must not skip the second profile just
    // because the first failed, or the report would be silently partial.
    const target = installation();
    const h = harness({
      resolution: { status: 'resolved', installation: target },
      resultFor: (_t, profile) =>
        result(target, profile, {
          status: 'failed',
          failureClass: 'capability-failure',
          remediation: 'This browser does not support popup-session.',
        }),
    });

    const run = await runCheck(h, ['--json']);

    expect(run.exitCode).toBe(3);
    expect(h.releases()).toEqual({ profiles: 2, shutdowns: 2 });
  });
});
