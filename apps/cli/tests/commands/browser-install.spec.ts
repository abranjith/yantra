import type { ManagedInstallOutcome, ManagedInstallService } from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

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

function service(outcome: ManagedInstallOutcome) {
  const install = vi.fn().mockResolvedValue(outcome);
  return {
    value: { install, collectOrphans: vi.fn() } as unknown as ManagedInstallService,
    install,
  };
}

const failed: ManagedInstallOutcome = {
  status: 'failed',
  error: {
    code: 'network-failure',
    phase: 'downloading',
    detail: 'Transfer failed.',
    remediation: 'Check the network and retry.',
    retainedOrphan: 'installation-one',
  },
};

describe('@no-llm browser install command', () => {
  it('refuses JSON without --yes, emits one envelope, and never reaches install', async () => {
    const stdout = sink();
    const stderr = sink();
    const runtime = service(failed);
    await expect(
      makeBrowserCommand({
        service: runtime.value,
        isTty: () => true,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }).parseAsync(['install', '--json'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(runtime.install).not.toHaveBeenCalled();
    expect(stdout.text().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout.text())).toMatchObject({
      kind: 'browser_install',
      outcome: { status: 'failed', error: { code: 'consent-required' } },
    });
    expect(stderr.text()).toContain('--yes');
  });

  it('records --yes consent, keeps progress on stderr, and emits one final JSON line', async () => {
    const stdout = sink();
    const stderr = sink();
    const outcome = {
      status: 'cancelled',
      at: 'downloading',
      retainedOrphan: 'installation-one',
    } as const;
    const runtime = service(outcome);
    runtime.install.mockImplementation(async (request) => {
      request.onProgress?.({
        phase: 'downloading',
        buildId: '153.0.8010.36',
        downloadedBytes: 50,
        totalBytes: 100,
        percent: 50,
        resumable: false,
        interruptible: true,
      });
      return outcome;
    });
    await expect(
      makeBrowserCommand({
        service: runtime.value,
        isTty: () => false,
        stdout: stdout.stream,
        stderr: stderr.stream,
        destinationRoot: () => '/managed',
        now: () => new Date('2026-09-14T00:00:00.000Z'),
      }).parseAsync(['install', '--yes', '--json'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(runtime.install.mock.calls[0]?.[0].consent).toMatchObject({
      source: 'cli-accept-flag',
      destinationRoot: '/managed',
    });
    expect(stdout.text().trim().split('\n')).toHaveLength(1);
    expect(stderr.text()).toContain('downloading 50%');
  });

  it('fails closed on an interactive decline without touching the service', async () => {
    const stdout = sink();
    const stderr = sink();
    const runtime = service(failed);
    await expect(
      makeBrowserCommand({
        service: runtime.value,
        isTty: () => true,
        prompt: vi.fn().mockResolvedValue({ granted: false }) as never,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }).parseAsync(['install'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(runtime.install).not.toHaveBeenCalled();
    expect(stderr.text()).toContain('no installation state changed');
  });

  it('renders a failed environment outcome in JSON and exits 3', async () => {
    const stdout = sink();
    const stderr = sink();
    const runtime = service(failed);
    await expect(
      makeBrowserCommand({
        service: runtime.value,
        isTty: () => false,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }).parseAsync(['install', '--yes', '--json'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(JSON.parse(stdout.text())).toMatchObject({
      outcome: { status: 'failed', error: { code: 'network-failure' } },
    });
    expect(stderr.text()).toContain('Transfer failed');
  });

  it('prints the installed build, destination, restart cost, and external-browser safety', async () => {
    const stdout = sink();
    const stderr = sink();
    const installed = {
      status: 'installed',
      record: {
        schemaVersion: 1,
        installationId: 'one',
        browser: 'chrome',
        platform: 'linux',
        buildId: '153.0.8010.36',
        cacheRootRelative: 'installation-one',
        executableRelative: 'chrome',
        verifiedAt: '2026-09-14T00:00:00.000Z',
      },
      executablePath: '/managed/chrome',
      compatibility: {} as never,
      orphans: { attempted: 0, deleted: 0, bytesReclaimed: 0, skippedLiveOwner: 0, failed: [] },
      selection: { configuredSource: 'auto', selectsThisInstallation: true, command: null },
    } as const;
    await makeBrowserCommand({
      service: service(installed).value,
      isTty: () => true,
      stdout: stdout.stream,
      stderr: stderr.stream,
    }).parseAsync(['install', '--yes'], { from: 'user' });
    expect(stdout.text()).toContain('153.0.8010.36');
    expect(stderr.text()).toContain('restart from zero');
    expect(stderr.text()).toContain('external Chrome installations are untouched');
  });
});
