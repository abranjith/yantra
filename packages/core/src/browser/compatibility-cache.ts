/**
 * Local compatibility evidence cache.
 *
 * The cache key carries everything that could change the answer — the exact
 * executable, its version and stat fingerprint, the host, the driver, the probe
 * revision, the capability-table hash, and the probe profile — so evidence
 * gathered under different requirements can never be served for a new question.
 * Only a *successful* result counts as evidence; failures are retained for
 * diagnostics but never satisfy a launch.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { DRIVER_COMPATIBILITY, capabilityTableHash } from './driver-compatibility.js';
import type {
  CompatibilityEvidenceState,
  CompatibilityResult,
  DriverCompatibilityDescriptor,
  ExecutableIdentity,
  ProbeProfile,
} from './installation-types.js';
import { browserCompatibilityCacheRoot } from './paths.js';

const ExecutableIdentitySchema = z.object({
  canonicalPath: z.string().min(1),
  version: z.string().min(1),
  majorVersion: z.number().int().nonnegative(),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  statFingerprint: z.string().min(1),
});

const CapabilityEvidenceSchema = z.object({
  capability: z.string().min(1),
  status: z.enum(['passed', 'failed', 'not-run']),
  reason: z.string().nullable(),
});

const CompatibilityResultSchema = z.object({
  schemaVersion: z.literal(1),
  identity: ExecutableIdentitySchema,
  driverVersion: z.string().min(1),
  testedBuild: z.string().min(1),
  probeRevision: z.number().int().nonnegative(),
  capabilityTableHash: z.string().min(1),
  profile: z.enum(['automation', 'recorder']),
  checkedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'invalid timestamp'),
  capabilities: z.array(CapabilityEvidenceSchema),
  verdict: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('passed'),
      pairing: z.enum(['tested', 'capability-checked']),
    }),
    z.object({
      status: z.literal('failed'),
      failureClass: z.enum([
        'missing-runtime-libraries',
        'capability-failure',
        'launch-environment',
      ]),
      remediation: z.string(),
    }),
  ]),
});

/**
 * Computes the cache key for one identity/profile pair.
 *
 * Every component is part of the question being asked, so a change in any of
 * them is a different question with a different file.
 */
export function compatibilityCacheKey(
  identity: ExecutableIdentity,
  profile: ProbeProfile,
  descriptor: DriverCompatibilityDescriptor = DRIVER_COMPATIBILITY,
): string {
  const material = [
    identity.canonicalPath,
    identity.version,
    identity.statFingerprint,
    identity.platform,
    identity.architecture,
    descriptor.driverVersion,
    String(descriptor.probeRevision),
    capabilityTableHash(descriptor),
    profile,
  ].join('');
  return createHash('sha256').update(material).digest('hex');
}

export interface CompatibilityCacheDeps {
  readonly root?: () => string;
  readonly descriptor?: DriverCompatibilityDescriptor;
}

/** Filesystem-backed evidence store under the cache directory. */
export class CompatibilityCache {
  private readonly root: () => string;
  private readonly descriptor: DriverCompatibilityDescriptor;

  constructor(deps: CompatibilityCacheDeps = {}) {
    this.root = deps.root ?? browserCompatibilityCacheRoot;
    this.descriptor = deps.descriptor ?? DRIVER_COMPATIBILITY;
  }

  private pathFor(identity: ExecutableIdentity, profile: ProbeProfile): string {
    return join(this.root(), `${compatibilityCacheKey(identity, profile, this.descriptor)}.json`);
  }

  /**
   * Reads cached *successful* evidence for this exact question.
   *
   * Returns `unverified` for anything else — no file, malformed content, a
   * result recorded under a different key, or a recorded failure. `unverified`
   * is an honest answer that `browser use` and doctor can report without
   * launching a browser.
   */
  async read(
    identity: ExecutableIdentity,
    profile: ProbeProfile,
  ): Promise<CompatibilityEvidenceState> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(identity, profile), 'utf8');
    } catch {
      return { state: 'unverified' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: 'unverified' };
    }

    const result = CompatibilityResultSchema.safeParse(parsed);
    if (!result.success) return { state: 'unverified' };

    const evidence = result.data as unknown as CompatibilityResult;
    if (evidence.verdict.status !== 'passed') return { state: 'unverified' };
    if (!this.matches(evidence, identity, profile)) return { state: 'unverified' };
    return { state: 'evidence', result: evidence };
  }

  /**
   * Re-checks the stored content against the question, not just the filename.
   *
   * A hash collision or a hand-edited file would otherwise let evidence about
   * one executable answer for another.
   */
  private matches(
    evidence: CompatibilityResult,
    identity: ExecutableIdentity,
    profile: ProbeProfile,
  ): boolean {
    return (
      evidence.profile === profile &&
      evidence.driverVersion === this.descriptor.driverVersion &&
      evidence.probeRevision === this.descriptor.probeRevision &&
      evidence.capabilityTableHash === capabilityTableHash(this.descriptor) &&
      evidence.identity.canonicalPath === identity.canonicalPath &&
      evidence.identity.version === identity.version &&
      evidence.identity.statFingerprint === identity.statFingerprint &&
      evidence.identity.platform === identity.platform &&
      evidence.identity.architecture === identity.architecture
    );
  }

  /** Records a result. Failures are stored for diagnostics, never as evidence. */
  async write(result: CompatibilityResult): Promise<void> {
    const path = this.pathFor(result.identity, result.profile);
    try {
      await mkdir(this.root(), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(result), { mode: 0o600 });
    } catch {
      // Losing the cache costs a new local probe, never an update or download.
    }
  }

  /** Removes any stored result for this question. */
  async invalidate(identity: ExecutableIdentity, profile: ProbeProfile): Promise<void> {
    await rm(this.pathFor(identity, profile), { force: true }).catch(() => undefined);
  }
}
