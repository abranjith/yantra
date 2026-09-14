import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DRIVER_COMPATIBILITY } from '../../src/browser/driver-compatibility.js';
import { managedBrowsersRoot, resetPathCache } from '../../src/browser/paths.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import { createLocalBrowserRuntimeServices } from '../../src/browser/runtime-services.js';

const runLiveInstall = process.env['YANTRA_E2E_MANAGED_INSTALL'] === '1';

describe.runIf(runLiveInstall)('@no-llm live managed Stable installation', () => {
  let root = '';
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-managed-live-'));
    previousHome = process.env['YANTRA_HOME'];
    process.env['YANTRA_HOME'] = root;
    resetPathCache();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['YANTRA_HOME'];
    else process.env['YANTRA_HOME'] = previousHome;
    resetPathCache();
    await rm(root, { recursive: true, force: true });
  });

  it('downloads Stable into the candidate tree, publishes it, and launches it', async () => {
    const profileStore = new LocalProfileStore();
    const services = createLocalBrowserRuntimeServices({ profileStore });
    const outcome = await services.installService?.install({
      trigger: 'explicit-command',
      consent: {
        granted: true,
        source: 'cli-accept-flag',
        grantedAt: new Date().toISOString(),
        destinationRoot: managedBrowsersRoot(),
        approximateBytes: 200 * 1024 * 1024,
      },
    });

    if (!DRIVER_COMPATIBILITY.isSupportedHost(process.platform, process.arch)) {
      expect(outcome).toMatchObject({
        status: 'failed',
        error: { code: 'unsupported-platform' },
      });
      return;
    }
    expect(outcome?.status).toBe('installed');
    if (outcome?.status !== 'installed') {
      throw new Error(`Managed Stable install failed: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.record.cacheRootRelative).toMatch(/^installation-/u);
    expect(outcome.executablePath.startsWith(managedBrowsersRoot())).toBe(true);

    const session = await new LocalBrowserProvider({ profileStore, services }).launch({
      profile: { kind: 'ephemeral' },
    });
    await session.close();
  }, 900_000);
});
