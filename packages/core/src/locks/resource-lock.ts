import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import pino from 'pino';
import lockfile from 'proper-lockfile';
import { z } from 'zod';

import {
  configPath,
  scheduleRegistryLockTarget,
  templatesRoot,
  workflowsRoot,
} from '../browser/paths.js';
import type { Logger } from '../browser/types.js';
import { writeFileAtomic } from '../fs/atomic-write.js';
import { profilePath } from '../profile/profile-file.js';

/** One shared writer domain. Browser profiles hold their lease for the session. */
export type LockedResource =
  | { readonly kind: 'config' }
  | { readonly kind: 'profile' }
  | { readonly kind: 'workflow'; readonly name: string }
  | { readonly kind: 'template'; readonly name: string }
  | { readonly kind: 'schedules' }
  | { readonly kind: 'browser-profile'; readonly path: string };

const OwnerSchema = z
  .object({
    pid: z.number().int().positive(),
    command: z.string().min(1),
    started_at: z.string().datetime(),
    surface: z.enum(['terminal', 'worker', 'daemon', 'host']),
  })
  .strict();

export type ResourceLockOwner = Readonly<z.infer<typeof OwnerSchema>>;

export interface ResourceLockOptions {
  /** Match an injected store/config path; the default is the standard paths.ts target. */
  readonly targetPath?: string;
  readonly owner?: ResourceLockOwner;
  readonly logger?: Pick<Logger, 'warn'>;
  readonly retries?: lockfile.LockOptions['retries'];
  /** External filesystem-lock boundary, injectable for compromise/error tests. */
  readonly lock?: typeof lockfile.lock;
}

export interface ResourceLease {
  readonly owner: ResourceLockOwner;
  /** Idempotent, including concurrent releases. */
  release(): Promise<void>;
}

const STALE_MS = 10_000;
const FILE_RETRIES = { retries: 25, factor: 1, minTimeout: 200, maxTimeout: 200 };

/** Contention only. Other filesystem failures retain their original error. */
export class ResourceBusyError extends Error {
  public override readonly name = 'ResourceBusyError';
  public readonly remediation = 'Try again when it finishes.';
  public constructor(
    public readonly resource: LockedResource,
    public readonly holder: ResourceLockOwner | null,
  ) {
    super(
      `${resourceLabel(resource)} is busy: ${holder === null ? 'in use by another process.' : `in use by ${holder.command} (pid ${holder.pid}) since ${holder.started_at}.`}`,
    );
  }
}

function resourceLabel(resource: LockedResource): string {
  return 'name' in resource ? `${resource.kind} "${resource.name}"` : resource.kind;
}

/** Resolve only validated names; a resource key cannot escape its store. */
export function resourceLockTarget(resource: LockedResource): string {
  validateResourceKey(resource);
  switch (resource.kind) {
    case 'config':
      return configPath();
    case 'profile':
      return profilePath();
    case 'schedules':
      return scheduleRegistryLockTarget();
    case 'browser-profile':
      return resolve(resource.path);
    case 'workflow':
    case 'template': {
      return resource.kind === 'workflow'
        ? join(workflowsRoot(), `${resource.name}.yaml`)
        : join(templatesRoot(), `${resource.name}.md`);
    }
  }
}

function validateResourceKey(resource: LockedResource): void {
  if ('name' in resource && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(resource.name))
    throw new Error(`Invalid ${resource.kind} lock name`);
  if (resource.kind === 'browser-profile' && !isAbsolute(resource.path))
    throw new Error('Browser profile lock path must be absolute');
}

async function targetFor(resource: LockedResource, options: ResourceLockOptions): Promise<string> {
  validateResourceKey(resource);
  const target = resolve(options.targetPath ?? resourceLockTarget(resource));
  if (resource.kind !== 'browser-profile') return target;
  // Two directory aliases still name one Chrome user-data directory.
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return target;
  }
}

async function readOwner(target: string): Promise<ResourceLockOwner | null> {
  try {
    const parsed = OwnerSchema.safeParse(
      JSON.parse(await readFile(`${target}.lock.owner.json`, 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    // Holder diagnostics are advisory; a missing/damaged sidecar never unlocks a resource.
    return null;
  }
}

/** Inspect the live lock, ignoring an orphan owner sidecar after a crash. */
export async function probeResourceLock(
  resource: LockedResource,
  options: ResourceLockOptions = {},
): Promise<ResourceLockOwner | null> {
  const target = await targetFor(resource, options);
  const held = await lockfile.check(target, {
    realpath: false,
    lockfilePath: `${target}.lock`,
    stale: STALE_MS,
  });
  return held ? await readOwner(target) : null;
}

/** Acquire a process-safe renewable lease. Persistent browser profiles never wait. */
export async function acquireResourceLease(
  resource: LockedResource,
  options: ResourceLockOptions = {},
): Promise<ResourceLease> {
  const target = await targetFor(resource, options);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const owner = OwnerSchema.parse(
    options.owner ?? {
      pid: process.pid,
      command: `yantra ${resource.kind}`,
      started_at: new Date().toISOString(),
      surface: 'terminal',
    },
  );
  // No default logger writes to a detached stdout. Adapters can supply their sink.
  const logger = options.logger ?? pino({ name: 'yantra.resource-lock' }, pino.destination(2));
  let compromised = false;
  let unlock: () => Promise<void>;
  try {
    unlock = await (options.lock ?? lockfile.lock)(target, {
      realpath: false,
      lockfilePath: `${target}.lock`,
      stale: STALE_MS,
      retries: options.retries ?? (resource.kind === 'browser-profile' ? 0 : FILE_RETRIES),
      onCompromised: (error) => {
        compromised = true;
        logger.warn(
          { resource, error_class: (error as NodeJS.ErrnoException).code ?? error.name },
          'Resource lock was compromised',
        );
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
    const holder = await readOwner(target);
    logger.warn({ resource, holder_pid: holder?.pid ?? null }, 'Resource is busy');
    throw new ResourceBusyError(resource, holder);
  }
  try {
    await writeFileAtomic(`${target}.lock.owner.json`, `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    await unlock();
    throw error;
  }
  let releasing: Promise<void> | undefined;
  return {
    owner,
    release() {
      releasing ??= (async () => {
        // A lease lost to another process must not remove that successor's owner.
        const current = await readOwner(target);
        if (!compromised && current?.pid === owner.pid && current.started_at === owner.started_at) {
          await rm(`${target}.lock.owner.json`, { force: true });
        }
        if (!compromised) await unlock();
      })();
      return releasing;
    },
  };
}

/** Hold the same lock across the complete read, mutate, validate, write operation. */
export async function withResourceLock<T>(
  resource: LockedResource,
  fn: () => T | Promise<T>,
  options: ResourceLockOptions = {},
): Promise<T> {
  const lease = await acquireResourceLease(resource, options);
  try {
    return await fn();
  } finally {
    await lease.release();
  }
}
