import { isAbsolute, win32 } from 'node:path';

import { z } from 'zod';

import { BrowserLaunchError } from './errors.js';
import type { BrowserSelection } from './installation-types.js';
import type { LaunchOptions } from './types.js';

export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

export const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/**
 * Hardened Chrome args added to every launch.
 * --remote-debugging-pipe and --user-data-dir are handled by the launcher, not here.
 */
export const HARDENED_BASE_ARGS: readonly string[] = Object.freeze([
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=TranslateUI',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
]);

const FORBIDDEN_EXTRA_ARGS = [
  '--remote-debugging-pipe',
  '--remote-debugging-port',
  '--user-data-dir',
  '--user-agent',
  '--disable-blink-features',
  '--lang',
];

export const ProfileSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workflow'),
    workflowName: z.string().min(1),
  }),
  z.object({ kind: z.literal('ephemeral') }),
  z.object({
    kind: z.literal('explicit'),
    absolutePath: z
      .string()
      .min(1)
      .refine((p) => isAbsolute(p), {
        message: 'explicit profile path must be absolute',
      }),
  }),
]);

/**
 * Zod schema for a browser selection.
 *
 * An explicit executable path is legal only with `system`: `auto` and
 * `managed` describe *how* to find a browser, so pairing either with a literal
 * path would mean two selections at once.
 */
export const BrowserSelectionSchema = z
  .object({
    source: z.enum(['auto', 'managed', 'system']),
    executablePath: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .refine((p) => p === null || isAbsolute(p) || win32.isAbsolute(p), {
        message: 'browser executable path must be absolute',
      }),
  })
  .refine((v) => v.executablePath === null || v.source === 'system', {
    message: 'an explicit executable path is legal only with source "system"',
    path: ['executablePath'],
  });

/**
 * Zod schema for LaunchOptions.
 * Validates all launch parameters with sensible defaults.
 *
 * @example
 * const opts = LaunchOptionsSchema.parse({ profile: { kind: 'ephemeral' } });
 */
export const LaunchOptionsSchema = z
  .object({
    profile: ProfileSpecSchema,
    headless: z.boolean().default(true),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .nullable()
      .default(DEFAULT_VIEWPORT),
    extraArgs: z
      .array(z.string())
      .default([])
      .refine((args) => !args.some((a) => FORBIDDEN_EXTRA_ARGS.some((f) => a.startsWith(f))), {
        message: `extraArgs must not contain: ${FORBIDDEN_EXTRA_ARGS.join(', ')} — managed by Yantra`,
      })
      .transform((args) => args as readonly string[]),
    env: z.record(z.string(), z.string()).default({}),
    startupTimeoutMs: z.number().int().positive().default(DEFAULT_STARTUP_TIMEOUT_MS),
    browserSelection: BrowserSelectionSchema.nullable().default(null),
  })
  .strict();

/**
 * Validates and parses raw input into a typed LaunchOptions object.
 * Throws BrowserLaunchError with Zod issues if validation fails.
 *
 * @param input - Raw options to validate
 * @returns Typed, validated LaunchOptions
 * @throws {BrowserLaunchError} when validation fails
 */
export function parseLaunchOptions(input: unknown): LaunchOptions {
  const result = LaunchOptionsSchema.safeParse(input);
  if (!result.success) {
    throw new BrowserLaunchError({
      phase: 'spawn',
      lastStderr: '',
      args: [
        'validation-failed',
        ...result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      ],
    });
  }
  return result.data;
}

/**
 * Translates validated launch options into the one selection the resolver takes.
 *
 * There is exactly one semantic browser choice: a null selection means "resolve
 * from the configured selection, then `auto`", never "use some other field".
 *
 * @returns The invocation selection, or undefined to fall through to config/auto.
 */
export function selectionFromLaunchOptions(opts: LaunchOptions): BrowserSelection | undefined {
  return opts.browserSelection ?? undefined;
}
