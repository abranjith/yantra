/**
 * Read-only view of the Yantra-managed browser tree.
 *
 * Nothing here writes or deletes. FEAT-044/046 own installation, publication,
 * and orphan collection; this module only answers two questions: which build
 * is ready, and which children the ready pointer does not name.
 */

import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

import { Browser, computeExecutablePath } from '@puppeteer/browsers';
import { z } from 'zod';

import {
  MANAGED_INSTALLATION_PREFIX,
  MANAGED_PLATFORMS,
  type ManagedInventory,
  type ManagedOrphan,
  type ManagedPlatform,
  type ManagedReadyRecord,
  type ManagedReadySnapshot,
  type ManagedStateReader,
} from './installation-types.js';
import { managedBrowsersRoot, managedReadyPath } from './paths.js';

/** Decimal dotted build identity, e.g. `152.0.7977.75`. */
const BUILD_ID_PATTERN = /^\d+(?:\.\d+)*$/;

/** Exactly one `installation-<opaque-id>` segment — no nesting, no traversal. */
const CHILD_CACHE_PATTERN = /^installation-[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isNormalizedRelative(value: string): boolean {
  if (value.length === 0) return false;
  if (isAbsolute(value) || win32.isAbsolute(value)) return false;
  const segments = value.split(/[\\/]/u);
  if (segments.length === 0) return false;
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Strict ready-record schema.
 *
 * Every field is rejected rather than repaired: a corrupt pointer is reported
 * as `invalid` so an explicit managed selection fails with remediation instead
 * of quietly falling through to whatever external Chrome happens to exist.
 */
export const ManagedReadyRecordSchema = z.object({
  schemaVersion: z.literal(1),
  installationId: z
    .string()
    .min(1)
    .refine((v) => !/[\\/]/u.test(v), { message: 'installationId must not contain a separator' }),
  browser: z.literal('chrome'),
  platform: z.enum(MANAGED_PLATFORMS as unknown as [ManagedPlatform, ...ManagedPlatform[]]),
  buildId: z.string().regex(BUILD_ID_PATTERN, 'buildId must be a decimal dotted build identity'),
  cacheRootRelative: z.string().refine((v) => CHILD_CACHE_PATTERN.test(v), {
    message: `cacheRootRelative must be exactly one "${MANAGED_INSTALLATION_PREFIX}<id>" segment`,
  }),
  executableRelative: z.string().refine(isNormalizedRelative, {
    message: 'executableRelative must be a normalized relative path',
  }),
  verifiedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'verifiedAt must be a valid timestamp',
  }),
});

/** Maps a validated ready platform onto the browsers API platform enum. */
function toBrowserPlatform(platform: ManagedPlatform): string {
  return platform;
}

/** Absolute path of the child cache root a ready record names. */
export function managedChildRoot(record: ManagedReadyRecord, root = managedBrowsersRoot()): string {
  return join(root, record.cacheRootRelative);
}

/**
 * Recomputes the managed executable from recorded relative identity.
 *
 * Absolute executable paths are never persisted, so a relocated data directory
 * still resolves. The recorded `executableRelative` is required to agree with
 * what the browsers API computes; disagreement means the record and the layout
 * describe different things and the installation is not trustworthy.
 */
export function managedExecutablePath(
  record: ManagedReadyRecord,
  root = managedBrowsersRoot(),
): { readonly path: string; readonly agrees: boolean } {
  const childRoot = managedChildRoot(record, root);
  const computed = computeExecutablePath({
    browser: Browser.CHROME,
    buildId: record.buildId,
    platform: toBrowserPlatform(record.platform) as never,
    cacheDir: childRoot,
  });
  const recorded = resolve(childRoot, record.executableRelative.split(/[\\/]/u).join(sep));
  return { path: computed, agrees: resolve(computed) === recorded };
}

/**
 * Refuses a non-default `@puppeteer/browsers` provider.
 *
 * Upstream writes absolute executable paths into `.metadata` only when the
 * provider is not the default one, so keeping the default provider is what
 * makes "recompute, never persist" true. This guard is the replacement for the
 * metadata-repair routine the plan deleted.
 */
export function assertDefaultBrowserProvider(options: {
  readonly provider?: unknown;
  readonly baseUrl?: unknown;
}): void {
  if (options.provider !== undefined && options.provider !== null) {
    throw new Error(
      'A custom @puppeteer/browsers provider is not permitted: managed installations must use the default official provider so executable paths stay recomputable.',
    );
  }
}

/** Is `candidate` inside `root` after both are canonicalized? */
export async function isContainedIn(candidate: string, root: string): Promise<boolean> {
  const canonicalRoot = await canonicalize(root);
  const canonicalCandidate = await canonicalize(candidate);
  if (canonicalRoot === null || canonicalCandidate === null) return false;
  const rel = relative(canonicalRoot, canonicalCandidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel) && !win32.isAbsolute(rel);
}

/**
 * Resolves symlinks and junctions where possible.
 *
 * A path that does not exist yet cannot be canonicalized, so its nearest
 * existing ancestor is canonicalized instead and the remainder appended —
 * otherwise containment checks would silently pass for missing paths.
 */
export async function canonicalize(target: string): Promise<string | null> {
  let current = resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return trailing.length === 0 ? real : join(real, ...trailing.reverse());
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return null;
      trailing.push(relative(parent, current));
      current = parent;
    }
  }
}

export interface ManagedStateReaderDeps {
  /** Overridable for tests; defaults to the resolved data directory. */
  readonly root?: () => string;
  readonly readyPath?: () => string;
  /**
   * Candidate cache root a live mutation lease currently names, if any.
   * TASK-002's coordinator supplies the real lookup; the default reports none.
   */
  readonly liveMutationCandidate?: () => Promise<string | null>;
}

/** Filesystem-backed {@link ManagedStateReader}. Never mutates the tree. */
export class LocalManagedStateReader implements ManagedStateReader {
  private readonly root: () => string;
  private readonly readyPath: () => string;
  private readonly liveMutationCandidate: () => Promise<string | null>;

  constructor(deps: ManagedStateReaderDeps = {}) {
    this.root = deps.root ?? managedBrowsersRoot;
    this.readyPath = deps.readyPath ?? managedReadyPath;
    this.liveMutationCandidate = deps.liveMutationCandidate ?? (() => Promise.resolve(null));
  }

  /** @inheritdoc */
  async readReady(): Promise<ManagedReadySnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.readyPath(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
      return { status: 'invalid', reason: `ready pointer is unreadable: ${describe(error)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { status: 'invalid', reason: `ready pointer is not valid JSON: ${describe(error)}` };
    }

    const result = ManagedReadyRecordSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      return {
        status: 'invalid',
        reason: `ready pointer is malformed: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'schema mismatch'}`,
      };
    }

    return { status: 'ready', record: result.data };
  }

  /** @inheritdoc */
  async readInventory(): Promise<ManagedInventory> {
    const ready = await this.readReady();
    const readyChild = ready.status === 'ready' ? ready.record.cacheRootRelative : null;
    const root = this.root();

    let entries: readonly string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return { ready, orphans: [] };
    }

    const liveCandidate = await this.liveMutationCandidate().catch(() => null);
    const orphans: ManagedOrphan[] = [];
    for (const name of entries.slice().sort()) {
      if (!name.startsWith(MANAGED_INSTALLATION_PREFIX)) continue;
      if (name === readyChild) continue;
      orphans.push({
        cacheRootRelative: name,
        bytes: await directoryBytes(join(root, name)),
        hasLiveOwner: liveCandidate === name,
      });
    }

    return { ready, orphans };
  }
}

/** Sums the apparent size of a tree without following symlinks out of it. */
async function directoryBytes(target: string): Promise<number> {
  let total = 0;
  const pending = [target];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await lstat(child)).size;
      } catch {
        // A file removed mid-walk simply contributes nothing.
      }
    }
  }
  return total;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
