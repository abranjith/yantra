import { describe, expect, it } from 'vitest';

import { BrowserLaunchError } from '../../src/browser/errors.js';
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  HARDENED_BASE_ARGS,
  parseLaunchOptions,
} from '../../src/browser/launch-options.js';

const ephemeralProfile = { kind: 'ephemeral' as const };

describe('@no-llm launch-options', () => {
  describe('defaults', () => {
    it('applies default headless=true', () => {
      const opts = parseLaunchOptions({ profile: ephemeralProfile });
      expect(opts.headless).toBe(true);
    });

    it('applies default viewport', () => {
      const opts = parseLaunchOptions({ profile: ephemeralProfile });
      expect(opts.viewport).toEqual(DEFAULT_VIEWPORT);
    });

    it('applies default startupTimeoutMs', () => {
      const opts = parseLaunchOptions({ profile: ephemeralProfile });
      expect(opts.startupTimeoutMs).toBe(DEFAULT_STARTUP_TIMEOUT_MS);
    });

    it('applies default empty extraArgs', () => {
      const opts = parseLaunchOptions({ profile: ephemeralProfile });
      expect(opts.extraArgs).toEqual([]);
    });

    it('applies default chromeOverridePath null', () => {
      const opts = parseLaunchOptions({ profile: ephemeralProfile });
      expect(opts.chromeOverridePath).toBeNull();
    });
  });

  describe('viewport', () => {
    it('accepts viewport: null', () => {
      const opts = parseLaunchOptions({ profile: ephemeralProfile, viewport: null });
      expect(opts.viewport).toBeNull();
    });

    it('accepts explicit viewport dimensions', () => {
      const opts = parseLaunchOptions({
        profile: ephemeralProfile,
        viewport: { width: 1920, height: 1080 },
      });
      expect(opts.viewport).toEqual({ width: 1920, height: 1080 });
    });

    it('rejects negative width', () => {
      expect(() =>
        parseLaunchOptions({ profile: ephemeralProfile, viewport: { width: -1, height: 800 } }),
      ).toThrow(BrowserLaunchError);
    });

    it('rejects zero width', () => {
      expect(() =>
        parseLaunchOptions({ profile: ephemeralProfile, viewport: { width: 0, height: 800 } }),
      ).toThrow(BrowserLaunchError);
    });
  });

  describe('extraArgs validation', () => {
    it('rejects --remote-debugging-pipe in extraArgs', () => {
      expect(() =>
        parseLaunchOptions({ profile: ephemeralProfile, extraArgs: ['--remote-debugging-pipe'] }),
      ).toThrow(BrowserLaunchError);
    });

    it('rejects --remote-debugging-port in extraArgs', () => {
      expect(() =>
        parseLaunchOptions({
          profile: ephemeralProfile,
          extraArgs: ['--remote-debugging-port=9222'],
        }),
      ).toThrow(BrowserLaunchError);
    });

    it('rejects --user-data-dir in extraArgs', () => {
      expect(() =>
        parseLaunchOptions({
          profile: ephemeralProfile,
          extraArgs: ['--user-data-dir=/some/path'],
        }),
      ).toThrow(BrowserLaunchError);
    });

    it.each([
      '--user-agent=custom',
      '--disable-blink-features=AutomationControlled',
      '--lang=fr-CA',
    ])('rejects launcher-managed compatibility arg %s', (arg) => {
      expect(() =>
        parseLaunchOptions({
          profile: ephemeralProfile,
          extraArgs: [arg],
        }),
      ).toThrow(BrowserLaunchError);
    });

    it('accepts safe extra args', () => {
      const opts = parseLaunchOptions({
        profile: ephemeralProfile,
        extraArgs: ['--disable-gpu', '--no-sandbox'],
      });
      expect(opts.extraArgs).toContain('--disable-gpu');
    });
  });

  describe('chromeOverridePath', () => {
    it('rejects empty string', () => {
      expect(() =>
        parseLaunchOptions({ profile: ephemeralProfile, chromeOverridePath: '' }),
      ).toThrow(BrowserLaunchError);
    });

    it('rejects relative path', () => {
      expect(() =>
        parseLaunchOptions({ profile: ephemeralProfile, chromeOverridePath: 'relative/path' }),
      ).toThrow(BrowserLaunchError);
    });

    it('accepts absolute path on POSIX', () => {
      const opts = parseLaunchOptions({
        profile: ephemeralProfile,
        chromeOverridePath: '/usr/bin/chromium',
      });
      expect(opts.chromeOverridePath).toBe('/usr/bin/chromium');
    });
  });

  describe('ProfileSpec', () => {
    it('accepts workflow profile spec', () => {
      const opts = parseLaunchOptions({
        profile: { kind: 'workflow', workflowName: 'my-workflow' },
      });
      expect(opts.profile).toEqual({ kind: 'workflow', workflowName: 'my-workflow' });
    });

    it('accepts ephemeral profile spec', () => {
      const opts = parseLaunchOptions({ profile: { kind: 'ephemeral' } });
      expect(opts.profile).toEqual({ kind: 'ephemeral' });
    });

    it('accepts explicit profile spec with absolute path', () => {
      const opts = parseLaunchOptions({
        profile: { kind: 'explicit', absolutePath: '/profiles/my-profile' },
      });
      expect(opts.profile).toEqual({ kind: 'explicit', absolutePath: '/profiles/my-profile' });
    });

    it('rejects explicit profile with relative path', () => {
      expect(() =>
        parseLaunchOptions({ profile: { kind: 'explicit', absolutePath: 'relative/path' } }),
      ).toThrow(BrowserLaunchError);
    });

    it('rejects unknown profile kind', () => {
      expect(() => parseLaunchOptions({ profile: { kind: 'unknown' } })).toThrow(
        BrowserLaunchError,
      );
    });
  });

  describe('BrowserLaunchError on validation failure', () => {
    it('throws BrowserLaunchError (not generic Error) on failure', () => {
      expect(() => parseLaunchOptions({})).toThrow(BrowserLaunchError);
    });

    it('includes issue details in error args', () => {
      try {
        parseLaunchOptions({});
      } catch (e) {
        expect(e).toBeInstanceOf(BrowserLaunchError);
        const err = e as BrowserLaunchError;
        expect(err.context.phase).toBe('spawn');
        expect(err.context.args.length).toBeGreaterThan(0);
      }
    });
  });

  describe('HARDENED_BASE_ARGS', () => {
    it('includes --no-first-run', () => {
      expect(HARDENED_BASE_ARGS).toContain('--no-first-run');
    });

    it('does not include --remote-debugging-pipe or --remote-debugging-port', () => {
      expect(HARDENED_BASE_ARGS).not.toContain('--remote-debugging-pipe');
      expect(HARDENED_BASE_ARGS).not.toContain('--remote-debugging-port');
    });

    it('does not include --user-data-dir', () => {
      const hasDataDir = HARDENED_BASE_ARGS.some((a) => a.startsWith('--user-data-dir'));
      expect(hasDataDir).toBe(false);
    });
  });
});
