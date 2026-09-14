import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ManagedInstallHelperClient } from '../../src/browser/managed-install-helper-client.js';
import {
  DEFAULT_MANAGED_INSTALL_POLICY,
  type HelperRequest,
} from '../../src/browser/managed-install-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_HELPER = resolve(HERE, '../../dist/browser/managed-install-helper.js');
const FIXTURE = join(HERE, 'fixtures', 'fake-install-helper.mjs');

describe('@no-llm managed install helper packaging', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('ships the compiled helper in the core dist layout', async () => {
    await expect(stat(DIST_HELPER)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it('launches a helper under process.execPath from a path containing spaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra helper space '));
    roots.push(root);
    const helper = join(root, 'fake helper.mjs');
    await copyFile(FIXTURE, helper);
    const request: HelperRequest = {
      protocolVersion: 1,
      operationId: 'happy',
      browser: 'chrome',
      platform:
        process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? 'mac' : 'linux',
      cacheDir: root,
      buildId: null,
      progressIntervalMs: 10,
    };
    await expect(
      new ManagedInstallHelperClient({ helperPath: () => helper }).run(request, {
        ...DEFAULT_MANAGED_INSTALL_POLICY,
        wholeOperationMs: 2_000,
        metadataMs: 500,
        stallMs: 500,
        treeExitMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: 'completed', buildId: '153.0.8010.36' });
  });
});
