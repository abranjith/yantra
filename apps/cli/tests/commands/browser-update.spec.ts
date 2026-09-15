/**
 * `yantra browser update` — the consented replacement mode.
 *
 * The invariant worth the most here is the consent contract: no code path may
 * reach the update service without a `DownloadConsentRecord` whose
 * `targetBuildId` is the build that was actually resolved. That is asserted on
 * the record the service received, not on the prompt that produced it.
 */

import type { ManagedUpdateOutcome, ManagedUpdateService } from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import { makeBrowserCommand } from '../../src/commands/browser.js';

const INSTALLED = '152.0.7977.75';
const STABLE = '153.0.8010.36';

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

function record(buildId: string) {
  return {
    schemaVersion: 1 as const,
    installationId: 'one',
    browser: 'chrome' as const,
    platform: 'linux' as const,
    buildId,
    cacheRootRelative: 'installation-one',
    executableRelative: 'chrome/chrome',
    verifiedAt: '2026-09-14T00:00:00.000Z',
  };
}

function build(buildId = STABLE) {
  return {
    buildId,
    platform: 'linux' as const,
    resolvedAt: '2026-09-14T00:00:00.000Z',
    artifactAvailable: true,
  };
}

const replaced: ManagedUpdateOutcome = {
  status: 'replaced',
  previousBuildId: INSTALLED,
  record: record(STABLE),
  executablePath: '/managed/installation-two/chrome/chrome',
  compatibility: {
    schemaVersion: 1,
    identity: {
      canonicalPath: '/managed/installation-two/chrome/chrome',
      version: STABLE,
      majorVersion: 153,
      platform: 'linux',
      architecture: 'x64',
      statFingerprint: 'fixture',
    },
    driverVersion: '25.10.0',
    testedBuild: INSTALLED,
    probeRevision: 1,
    capabilityTableHash: 'fixture',
    profile: 'automation',
    checkedAt: '2026-09-14T00:00:00.000Z',
    capabilities: [],
    verdict: { status: 'passed', pairing: 'capability-checked' },
  },
  orphans: { attempted: 1, deleted: 1, bytesReclaimed: 2_048, skippedLiveOwner: 0, failed: [] },
  selection: {
    configuredSource: 'auto',
    selectsThisInstallation: true,
    command: null,
  },
};

interface HarnessOptions {
  readonly installed?: string;
  readonly available?: string;
  readonly preflight?: unknown;
  readonly resolution?: unknown;
  readonly outcome?: ManagedUpdateOutcome;
  readonly isTty?: boolean;
  readonly confirm?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const stdout = sink();
  const stderr = sink();
  const installedBuildId = options.installed ?? INSTALLED;
  const preflightMutation = vi
    .fn()
    .mockResolvedValue(options.preflight ?? { status: 'ready', record: record(installedBuildId) });
  const resolveTarget = vi
    .fn()
    .mockResolvedValue(
      options.resolution ?? { status: 'resolved', build: build(options.available ?? STABLE) },
    );
  const update = vi.fn().mockResolvedValue(options.outcome ?? replaced);
  const checkAvailability = vi.fn(() => {
    throw new Error('checkAvailability() must never be reached by the mutation mode');
  });
  const prompt = vi.fn().mockResolvedValue({ granted: options.confirm ?? false });

  const command = makeBrowserCommand({
    updateService: {
      preflightMutation,
      resolveTarget,
      update,
      checkAvailability,
    } as unknown as ManagedUpdateService,
    isTty: () => options.isTty ?? true,
    prompt: prompt as never,
    destinationRoot: () => '/managed',
    now: () => new Date('2026-09-14T00:00:00.000Z'),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  return { command, stdout, stderr, preflightMutation, resolveTarget, update, prompt };
}

describe('@no-llm browser update command', () => {
  // -------------------------------------------------------------------------
  // Order of operations
  // -------------------------------------------------------------------------

  it('refuses without a managed installation, exit 3, before any metadata call', async () => {
    const h = harness({
      preflight: {
        status: 'refused',
        error: {
          code: 'no-managed-installation',
          phase: 'preflight',
          remediation: 'Run `yantra browser install` to install the managed browser first.',
          detail: 'There is no managed installation to replace.',
          retainedOrphan: null,
        },
      },
    });

    await expect(h.command.parseAsync(['update'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 3,
    });
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.stderr.text()).toContain('yantra browser install');
  });

  it('refuses while a managed browser runs, naming the PIDs, before any metadata call', async () => {
    const h = harness({
      preflight: {
        status: 'refused',
        error: {
          code: 'managed-run-active',
          phase: 'preflight',
          remediation:
            'Stop the running Yantra browser sessions, then run `yantra browser update` again.',
          detail: 'A Yantra-managed browser is running (pid 4242).',
          activeOwnerPids: [4242],
          retainedOrphan: null,
        },
      },
    });

    await expect(h.command.parseAsync(['update'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 3,
    });
    expect(h.resolveTarget).not.toHaveBeenCalled();
    expect(h.stderr.text()).toContain('4242');
    expect(h.stderr.text()).toContain('Stop the running Yantra browser sessions');
  });

  it('exits 3 when Stable cannot be resolved, stating the installation is unaffected', async () => {
    const h = harness({
      resolution: {
        status: 'unavailable',
        error: {
          code: 'metadata-unavailable',
          phase: 'resolving-stable',
          remediation: 'Check network access to Chrome for Testing metadata and retry.',
          detail: 'Metadata host is unreachable.',
          retainedOrphan: null,
        },
      },
    });

    await expect(h.command.parseAsync(['update'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 3,
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.stderr.text()).toContain('still usable offline');
    expect(h.stderr.text()).toContain(INSTALLED);
  });

  // -------------------------------------------------------------------------
  // No-op verdicts never prompt
  // -------------------------------------------------------------------------

  it('reports up-to-date without prompting, downloading, or exiting non-zero', async () => {
    const h = harness({ installed: STABLE, available: STABLE });
    await h.command.parseAsync(['update'], { from: 'user' });
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.stdout.text()).toContain('Nothing to do');
  });

  it('never downgrades and never prompts when the installed build is newer', async () => {
    const h = harness({ installed: '154.0.1.0', available: STABLE });
    await h.command.parseAsync(['update'], { from: 'user' });
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.stdout.text()).toContain('never downgrades');
  });

  // The ordering grammar is core's. A string compare would place `…8010.36`
  // before `…8010.9` and silently refuse a real update.
  it('treats 153.0.8010.36 as newer than 153.0.8010.9 rather than comparing strings', async () => {
    const h = harness({ installed: '153.0.8010.9', available: '153.0.8010.36' });
    await h.command.parseAsync(['update', '--yes'], { from: 'user' });
    expect(h.update).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Consent
  // -------------------------------------------------------------------------

  it('states the current build, the proposal, the destination, the size, the restart cost, and external safety', async () => {
    const h = harness({ isTty: true, confirm: true });
    await h.command.parseAsync(['update'], { from: 'user' });
    const notice = h.stderr.text();
    expect(notice).toContain(INSTALLED);
    expect(notice).toContain(STABLE);
    expect(notice).toContain('/managed');
    expect(notice).toContain('200 MB');
    expect(notice).toContain('restarts from zero');
    expect(notice).toContain('External Chrome installations are untouched');
  });

  it('hands the service a consent record naming the exact resolved build', async () => {
    const h = harness({ isTty: true, confirm: true });
    await h.command.parseAsync(['update'], { from: 'user' });

    expect(h.update).toHaveBeenCalledOnce();
    const request = h.update.mock.calls[0]![0] as {
      consent: Record<string, unknown>;
      target: { buildId: string };
    };
    expect(request.consent).toMatchObject({
      granted: true,
      source: 'cli-update-prompt',
      targetBuildId: STABLE,
      replaces: INSTALLED,
    });
    // The build consented to is the build handed over. Nothing re-resolves.
    expect(request.target.buildId).toBe(STABLE);
    expect(h.resolveTarget).toHaveBeenCalledOnce();
  });

  it('records --yes as flag acceptance and skips the prompt', async () => {
    const h = harness({ isTty: true });
    await h.command.parseAsync(['update', '--yes'], { from: 'user' });
    expect(h.prompt).not.toHaveBeenCalled();
    expect((h.update.mock.calls[0]![0] as { consent: { source: string } }).consent.source).toBe(
      'cli-accept-flag',
    );
  });

  it('exits 4 on a declined prompt, changing nothing', async () => {
    const h = harness({ isTty: true, confirm: false });
    await expect(h.command.parseAsync(['update'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 4,
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.stderr.text()).toContain('no installation state changed');
  });

  it.each([
    ['non-TTY', ['update'], false],
    ['--json', ['update', '--json'], true],
  ] as const)(
    'refuses %s without --yes with exit 1 and never reaches the service',
    async (_label, argv, isTty) => {
      const h = harness({ isTty });
      await expect(h.command.parseAsync([...argv], { from: 'user' })).rejects.toMatchObject({
        exitCode: 1,
      });
      expect(h.prompt).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
      expect(h.stderr.text()).toContain('--yes');
    },
  );

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  it('emits exactly one stdout line in JSON mode with progress on stderr', async () => {
    const h = harness({ isTty: false });
    h.update.mockImplementation(async (request: { onProgress?: (e: unknown) => void }) => {
      request.onProgress?.({
        phase: 'downloading',
        buildId: STABLE,
        downloadedBytes: 50,
        totalBytes: 100,
        percent: 50,
        resumable: false,
        interruptible: true,
      });
      return replaced;
    });

    await h.command.parseAsync(['update', '--json', '--yes'], { from: 'user' });

    const lines = h.stdout.text().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      kind: 'browser_update',
      dryRun: false,
      outcome: {
        status: 'replaced',
        previousBuildId: INSTALLED,
        record: { buildId: STABLE },
        orphans: { deleted: 1, bytesReclaimed: 2_048 },
        selection: { selectsThisInstallation: true },
      },
    });
    expect(h.stderr.text()).toContain('downloading 50%');
  });

  it('renders capability-checked as ordinary provenance, with no warning styling', async () => {
    const h = harness({ isTty: true });
    await h.command.parseAsync(['update', '--yes'], { from: 'user' });
    const out = h.stdout.text();
    expect(out).toContain('capability-checked against this exact build');
    expect(out.toLowerCase()).not.toContain('warning');
    expect(out).not.toContain('!');
  });

  it('names the selection command when the configured selection does not select the installation', async () => {
    const h = harness({
      isTty: true,
      outcome: {
        ...replaced,
        selection: {
          configuredSource: 'system',
          selectsThisInstallation: false,
          command: 'yantra browser use managed',
        },
      },
    });
    await h.command.parseAsync(['update', '--yes'], { from: 'user' });
    expect(h.stderr.text()).toContain('yantra browser use managed');
  });

  it('exits 4 on cancellation and states the installation is unchanged', async () => {
    const h = harness({
      isTty: true,
      outcome: {
        status: 'cancelled',
        at: 'downloading',
        retainedOrphan: 'installation-two',
        record: record(INSTALLED),
      },
    });
    await expect(h.command.parseAsync(['update', '--yes'], { from: 'user' })).rejects.toMatchObject(
      {
        exitCode: 4,
      },
    );
    expect(h.stderr.text()).toContain('unchanged');
  });

  it('exits 3 on failure and reports the surviving installation', async () => {
    const h = harness({
      isTty: true,
      outcome: {
        status: 'failed',
        error: {
          code: 'extraction-failure',
          phase: 'extracting',
          remediation: 'Verify the named archive tool works and retry.',
          detail: 'The archive could not be expanded.',
          retainedOrphan: 'installation-two',
        },
        record: { status: 'ready', record: record(INSTALLED) },
      },
    });
    await expect(h.command.parseAsync(['update', '--yes'], { from: 'user' })).rejects.toMatchObject(
      {
        exitCode: 3,
      },
    );
    expect(h.stderr.text()).toContain(`Managed Chrome ${INSTALLED} is unchanged`);
  });

  // Consent that names the wrong build is a validation failure, not an
  // environment one: nothing about the host is broken, the request was.
  it('exits 1 when consent names a build other than the one resolved', async () => {
    const h = harness({
      isTty: true,
      outcome: {
        status: 'failed',
        error: {
          code: 'consent-build-mismatch',
          phase: 'preflight',
          remediation: 'Re-run `yantra browser update`.',
          detail: 'Consent named a different build than the operation would install.',
          retainedOrphan: null,
        },
        record: { status: 'ready', record: record(INSTALLED) },
      },
    });
    await expect(h.command.parseAsync(['update', '--yes'], { from: 'user' })).rejects.toMatchObject(
      {
        exitCode: 1,
      },
    );
  });

  it('gives each failure code its own user text', async () => {
    const codes = ['extraction-failure', 'network-failure', 'insufficient-disk-space'] as const;
    const texts: string[] = [];
    for (const code of codes) {
      const h = harness({
        isTty: true,
        outcome: {
          status: 'failed',
          error: {
            code,
            phase: 'downloading',
            remediation: `remediation for ${code}`,
            detail: `detail for ${code}`,
            retainedOrphan: null,
          },
          record: { status: 'ready', record: record(INSTALLED) },
        },
      });
      await expect(
        h.command.parseAsync(['update', '--yes'], { from: 'user' }),
      ).rejects.toBeDefined();
      texts.push(h.stderr.text());
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('never prints raw helper stderr, an archive command line, or a proxy credential', async () => {
    const h = harness({
      isTty: true,
      outcome: {
        status: 'failed',
        error: {
          code: 'proxy-failure',
          phase: 'downloading',
          remediation: 'Check the configured proxy and retry.',
          detail: 'The proxy refused the connection.',
          proxyHost: 'proxy.internal:3128',
          retainedOrphan: null,
        },
        record: { status: 'ready', record: record(INSTALLED) },
      },
    });
    await expect(h.command.parseAsync(['update', '--yes'], { from: 'user' })).rejects.toBeDefined();
    const output = `${h.stdout.text()}${h.stderr.text()}`;
    expect(output).not.toMatch(/hunter2|password|tar\.exe|unzip -|powershell\.exe/iu);
  });

  it('suggests no recovery, resume, or repair anywhere in its output', async () => {
    const h = harness({
      isTty: true,
      outcome: {
        status: 'cancelled',
        at: 'downloading',
        retainedOrphan: 'installation-two',
        record: record(INSTALLED),
      },
    });
    await expect(h.command.parseAsync(['update', '--yes'], { from: 'user' })).rejects.toBeDefined();
    const output = `${h.stdout.text()}${h.stderr.text()}`.toLowerCase();
    // A killed operation leaves an orphan the next explicit command collects.
    // There is nothing to resume and nothing for the user to repair, so no
    // message may offer either. "There is no resume" is the opposite claim and
    // is expected, which is why this matches suggestions rather than the words.
    expect(output).not.toMatch(
      /\b(?:can|to|please|try|run\b.*)\s+(?:resume|repair|recover)\b|resuming|repairing|recovery/u,
    );
    expect(output).not.toContain('did not finish');
    expect(output).not.toContain('incomplete update');
    expect(output).toContain('there is no resume');
  });
});
