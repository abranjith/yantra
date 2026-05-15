import * as fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalProfileStore } from '../../src/browser/profile-store.js';
import type { Logger } from '../../src/browser/types.js';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
  tmpdir: vi.fn(() => '/tmp'),
}));
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2)}`),
}));
vi.mock('../../src/browser/paths.js', () => ({
  dataDir: vi.fn(() => '/home/testuser/.local/share/yantra'),
  ephemeralRoot: vi.fn(() => '/tmp'),
}));

const mockMkdir = vi.mocked(await import('node:fs/promises').then((m) => m.mkdir));
const mockRm = vi.mocked(await import('node:fs/promises').then((m) => m.rm));

const silentLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('@no-llm launcher property tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined as unknown as string);
    mockRm.mockResolvedValue(undefined);
  });

  describe('ephemeral profile: no temp dir leaks on create + cleanup cycle', () => {
    it('100 sequential ephemeral sessions clean up their dirs', async () => {
      const createdPaths: string[] = [];

      mockMkdir.mockImplementation(async (path: unknown) => {
        if (String(path).includes('yantra-')) createdPaths.push(String(path));
        return undefined as unknown as string;
      });

      const store = new LocalProfileStore({ logger: silentLogger });

      for (let i = 0; i < 100; i++) {
        const profile = await store.resolve({ kind: 'ephemeral' });
        await store.cleanupEphemeral(profile.absolutePath);
      }

      // Every path that was created must have been cleaned up
      const cleanedPaths = mockRm.mock.calls.map((call) => call[0] as string);
      for (const created of createdPaths) {
        expect(cleanedPaths).toContain(created);
      }
    });

    it('fast-check: ephemeral cleanup always removes the created path', () =>
      fc.assert(
        fc.asyncProperty(fc.constant(undefined), async () => {
          mockMkdir.mockResolvedValue(undefined as unknown as string);
          mockRm.mockResolvedValue(undefined);

          const store = new LocalProfileStore({ logger: silentLogger });
          const profile = await store.resolve({ kind: 'ephemeral' });
          await store.cleanupEphemeral(profile.absolutePath);

          const calledPaths = mockRm.mock.calls.map((c) => c[0] as string);
          expect(calledPaths).toContain(profile.absolutePath);
        }),
        { numRuns: 50 },
      ));
  });

  describe('launch failure → cleanup: ephemeral dir still cleaned on error', () => {
    it('cleanupEphemeral is idempotent across error scenarios', () =>
      fc.assert(
        fc.asyncProperty(
          fc.constantFrom<'ENOENT' | 'EBUSY' | null>('ENOENT', 'EBUSY', null),
          async (errorCode) => {
            if (errorCode !== null) {
              mockRm.mockRejectedValueOnce(
                Object.assign(new Error(errorCode), { code: errorCode }),
              );
            } else {
              mockRm.mockResolvedValueOnce(undefined);
            }

            const store = new LocalProfileStore({ logger: silentLogger });
            // Must never throw regardless of error code
            await expect(store.cleanupEphemeral('/tmp/yantra-test-path')).resolves.toBeUndefined();
          },
        ),
        { numRuns: 30 },
      ));
  });

  describe('workflow profile names: valid names resolve, invalid ones are rejected', () => {
    it('fast-check: valid names always resolve without ProfilePathRefusedError', () =>
      fc.assert(
        fc.asyncProperty(
          fc
            .string({ minLength: 1, maxLength: 20 })
            .filter((s) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)),
          async (workflowName) => {
            vi.mocked(await import('node:fs/promises').then((m) => m.access)).mockRejectedValueOnce(
              new Error('ENOENT'),
            );
            const store = new LocalProfileStore({ logger: silentLogger });
            const result = await store.resolve({ kind: 'workflow', workflowName });
            expect(result.kind).toBe('workflow');
            expect(result.absolutePath).toContain(workflowName);
          },
        ),
        { numRuns: 50 },
      ));

    it('fast-check: names with spaces, slashes, or special chars are rejected', () =>
      fc.assert(
        fc.asyncProperty(
          fc
            .string({ minLength: 1, maxLength: 30 })
            .filter((s) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)),
          async (badName) => {
            const store = new LocalProfileStore({ logger: silentLogger });
            const { ProfilePathRefusedError } = await import('../../src/browser/errors.js');
            await expect(
              store.resolve({ kind: 'workflow', workflowName: badName }),
            ).rejects.toBeInstanceOf(ProfilePathRefusedError);
          },
        ),
        { numRuns: 50 },
      ));
  });
});
