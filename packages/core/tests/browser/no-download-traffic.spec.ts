import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      compatibility: { check: vi.fn(), decide: vi.fn(), readCached: vi.fn() },
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

/**
 * The update-metadata boundary.
 *
 * An accidental metadata fetch is silent — no exception, no log line, no type
 * error — so it needs a standing assertion at the boundary rather than an
 * inspection of any one command's output. These tests read the shipped source
 * because the claim is about *which modules can reach the boundary at all*,
 * which no runtime call count can establish for the modules that never ran.
 */
describe('@no-llm update-metadata boundary', () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

  /** Every `.ts` file under `src`, with its text. */
  async function sources(): Promise<readonly (readonly [string, string])[]> {
    const found: (readonly [string, string])[] = [];
    const pending = [SRC];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const child = join(current, entry.name);
        if (entry.isDirectory()) pending.push(child);
        else if (entry.name.endsWith('.ts'))
          found.push([relative(SRC, child).replace(/\\/gu, '/'), await readFile(child, 'utf8')]);
      }
    }
    return found;
  }

  it('resolves Stable in exactly one module — the owned helper', async () => {
    const callers = (await sources())
      .filter(([, text]) => /\bresolveBuildId\s*\(/u.test(text))
      .map(([path]) => path);
    expect(callers).toEqual(['browser/managed-install-helper.ts']);
  });

  it('downloads in exactly one module — the same owned helper', async () => {
    const callers = (await sources())
      .filter(([, text]) => /^\s*const .*= await install\(\{/mu.test(text))
      .map(([path]) => path);
    expect(callers).toEqual(['browser/managed-install-helper.ts']);
  });

  // One acquisition, not two: `install` mode is constructed in exactly one
  // place, so update cannot have grown a second path that verifies or publishes
  // differently. The metadata-only `resolve` mode is a separate, narrower thing.
  it('constructs an install-mode helper request in exactly one module', async () => {
    const callers = (await sources())
      .filter(([, text]) => /mode:\s*'install'/u.test(text))
      .map(([path]) => path);
    expect(callers).toEqual(['browser/managed-install.ts']);
  });

  it('requests resolve mode only from the availability module', async () => {
    const callers = (await sources())
      .filter(([, text]) => /mode:\s*'resolve'/u.test(text))
      .map(([path]) => path);
    expect(callers).toEqual(['browser/managed-availability.ts']);
  });

  /**
   * Modules reachable from ordinary operation, and the boundary they must not
   * import. `doctor`, `inventory`, and the resolver are the local read-only
   * surfaces; the provider and launcher are the run path; the scheduler and
   * daemon live above them and reach a browser only through these.
   */
  it.each([
    'browser/doctor.ts',
    'browser/inventory.ts',
    'browser/browser-resolver.ts',
    'browser/provider.ts',
    'browser/launcher.ts',
    'browser/compatibility.ts',
    'browser/managed-state.ts',
    'browser/selection-validation.ts',
    'browser/config-selection.ts',
  ])('%s cannot reach the update-metadata boundary', async (module) => {
    const text = await readFile(join(SRC, module), 'utf8');
    expect(text).not.toMatch(/managed-availability|managed-update/u);
    expect(text).not.toMatch(/resolveBuildId|canDownload/u);
  });

  it('keeps the update service off every runtime path but the CLI command', async () => {
    const importers = (await sources())
      .filter(([path, text]) => path !== 'browser/index.ts' && /managed-update\.js/u.test(text))
      .map(([path]) => path);
    // Only the composition root wires it, and it does so lazily.
    expect(importers).toEqual(['browser/runtime-services.ts']);
  });

  it('never persists that a check happened — no timestamp, no availability cache', async () => {
    const availability = await readFile(join(SRC, 'browser', 'managed-availability.ts'), 'utf8');
    const update = await readFile(join(SRC, 'browser', 'managed-update.ts'), 'utf8');
    for (const text of [availability, update]) {
      // A stored "last checked" is the seed of the background-check feature the
      // plan forbids, so its absence is asserted rather than assumed.
      expect(text).not.toMatch(/lastChecked|writeFile|mkdir|appendFile/u);
    }
  });
});
