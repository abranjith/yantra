import { describe, expect, it, vi } from 'vitest';

import { BrowserResolutionError } from '../../src/browser/errors.js';
import * as browserExports from '../../src/browser/index.js';
import type { BrowserRuntimeServices } from '../../src/browser/installation-types.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';

describe('@no-llm browser acquisition traffic boundary', () => {
  it('does not call install when ordinary startup has no human gateway', async () => {
    LocalBrowserProvider.resetInstallOfferForTests();
    const error = new BrowserResolutionError({
      code: 'missing',
      message: 'No browser.',
      requestedSelection: { source: 'auto', executablePath: null },
      remediation: 'Run `yantra browser install`.',
    });
    const install = vi.fn();
    const services = {
      resolver: { resolve: vi.fn().mockResolvedValue({ status: 'unavailable', error }) },
      compatibility: { check: vi.fn(), readCached: vi.fn() },
      coordinator: { reserveUse: vi.fn(), claimMutation: vi.fn(), hasActiveUse: vi.fn() },
      managedState: { readReady: vi.fn(), readInventory: vi.fn() },
      installService: { install, collectOrphans: vi.fn() },
      installOfferGateway: null,
    } as unknown as BrowserRuntimeServices;
    const provider = new LocalBrowserProvider({
      profileStore: {
        resolve: vi.fn(),
        listWorkflowProfiles: vi.fn(),
        removeWorkflowProfile: vi.fn(),
        cleanupEphemeral: vi.fn(),
      },
      services,
    });
    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBe(error);
    expect(install).not.toHaveBeenCalled();
  });

  it('exposes no model-visible browser install or update tool from core', () => {
    expect(
      Object.keys(browserExports).filter((name) => /install.*tool|update.*tool/i.test(name)),
    ).toEqual([]);
  });
});
