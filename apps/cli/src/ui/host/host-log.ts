/**
 * `host.log` (FEAT-065 TASK-005, §11): the app host's structured Pino log.
 *
 * - Rotated once at start: a log over 10 MiB becomes `host.log.1`.
 * - Owner-only (0600).
 * - Never records a launch or resume code, cookie, capability, token, signed
 *   URL or secret. Two layers enforce it: Pino `redact` paths for the known
 *   field names, and a recursive key scrub so a matching key at any depth is
 *   replaced too. The canary tests in TASK-005 and TASK-013 prove both.
 */

import { mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import pino, { type Logger } from 'pino';

import type { HostLogger } from './host.js';

/** Size over which `host.log` is rotated at start (10 MiB). */
export const HOST_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/** What every redacted value becomes. */
export const REDACTED = '[redacted]';

/**
 * Keys whose values are never logged, at any depth: any key ending in `code`
 * or `url` (`launch_code`, `signed_url`), and any key containing cookie,
 * capability, token, secret, password or authorization.
 */
export const SECRET_KEY_PATTERN =
  /(^|_)(codes?|urls?)$|cookie|capabilit|token|secret|password|authorization/iu;

const REDACT_FIELDS = [
  'code',
  'launch_code',
  'resume_code',
  'cookie',
  'capability',
  'window_capability',
  'token',
  'control_token',
  'run_token',
  'signed_url',
  'url',
  'secret',
  'password',
  'authorization',
] as const;

/** Pino `redact` paths: each field at the top level and one level down. */
export const HOST_LOG_REDACT_PATHS: readonly string[] = REDACT_FIELDS.flatMap((field) => [
  field,
  `*.${field}`,
]);

/** Returns a copy of `value` with every secret-named key replaced by {@link REDACTED}. */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : scrubSecrets(item, depth + 1);
  }
  return out;
}

/** Moves `path` to `path.1` when it is over `limit` bytes. Returns whether it rotated. */
export function rotateIfLarge(path: string, limit = HOST_LOG_ROTATE_BYTES): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size <= limit) return false;
  renameSync(path, `${path}.1`);
  return true;
}

/** An open `host.log`: the logger plus a synchronous flush for shutdown. */
export interface HostLog {
  readonly logger: HostLogger;
  readonly pino: Logger;
  flush(): void;
}

/**
 * Opens `host.log` at `path` (rotating first) with redaction. Writes are
 * synchronous: the host logs rarely, and a crash must not lose the last line.
 */
export function openHostLog(
  path: string,
  options: { readonly rotateBytes?: number } = {},
): HostLog {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rotateIfLarge(path, options.rotateBytes);
  const destination = pino.destination({ dest: path, sync: true, mode: 0o600, append: true });
  const logger = pino(
    {
      name: 'yantra-app-host',
      level: 'info',
      base: { pid: process.pid },
      redact: { paths: [...HOST_LOG_REDACT_PATHS], censor: REDACTED },
      formatters: {
        log: (object) => scrubSecrets(object) as Record<string, unknown>,
      },
    },
    destination,
  );
  return {
    pino: logger,
    logger: {
      info: (fields, message) => {
        logger.info(fields, message);
      },
      warn: (fields, message) => {
        logger.warn(fields, message);
      },
      error: (fields, message) => {
        logger.error(fields, message);
      },
    },
    flush: () => {
      destination.flushSync();
    },
  };
}
