/**
 * The public-artifact gate (FEAT-066 TASK-001).
 *
 * {@link resolvePublicArtifact} is the only way the app host reaches a file
 * inside a run directory. In order, it:
 *
 * 1. validates the run id (before any filesystem call);
 * 2. classifies the path against `RUN_ARTIFACT_REGISTRY` and refuses denied
 *    paths (`not_public`);
 * 3. `realpath`s the run directory and the target;
 * 4. requires the target to stay inside the run directory (`outside_run`),
 *    which defeats symlinks and Windows junctions, and requires the resolved
 *    name to classify to the same entry, so a link cannot reach a denied file;
 * 5. requires a regular file (`not_found` otherwise);
 * 6. returns `{absPath, entry, bytes, mtime}`.
 */

import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  classifyRunArtifact,
  isRunId,
  normalizeRunArtifactPath,
  type RunArtifactExposure,
  type RunArtifactRegistryEntry,
} from '@yantra/protocol';

import { ArtifactAccessError } from './errors.js';

/** A reachable public run file. */
export interface PublicArtifact {
  readonly absPath: string;
  /** The run-relative, forward-slash path. */
  readonly relPath: string;
  readonly entry: RunArtifactRegistryEntry;
  readonly bytes: number;
  readonly mtime: Date;
}

/** The filesystem calls the gate makes; injected in tests. */
export interface ArtifactGateFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; size: number; mtime: Date }>;
}

/** Node's `fs/promises`. */
export const NODE_ARTIFACT_GATE_FS: ArtifactGateFs = {
  realpath: (path) => fsRealpath(path),
  stat: (path) => fsStat(path),
};

export interface ResolveArtifactOptions {
  /** Exposures the caller serves; defaults to every exposure but `denied`. */
  readonly exposures?: readonly RunArtifactExposure[];
  /** Refuse with `too_large` when the file exceeds the entry's inline cap. */
  readonly requireInline?: boolean;
  readonly fs?: ArtifactGateFs;
}

const SERVABLE: readonly RunArtifactExposure[] = ['typed', 'view', 'download'];

/** True when `child` is `parent` or inside it (both already real paths). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolves one public run artifact; see the module comment.
 *
 * @param runsRoot - The runs directory, from `runsRoot()` in `browser/paths.ts`.
 * @throws {ArtifactAccessError} with the reason code.
 */
export async function resolvePublicArtifact(
  runsRoot: string,
  runId: string,
  relPath: string,
  options: ResolveArtifactOptions = {},
): Promise<PublicArtifact> {
  if (!isRunId(runId)) throw new ArtifactAccessError('invalid_run_id');
  const normalized = normalizeRunArtifactPath(relPath);
  const entry = classifyRunArtifact(relPath);
  const exposures = options.exposures ?? SERVABLE;
  if (normalized === null || entry.exposure === 'denied' || !exposures.includes(entry.exposure)) {
    throw new ArtifactAccessError('not_public', entry.exposure === 'denied' ? null : entry.id);
  }
  const fs = options.fs ?? NODE_ARTIFACT_GATE_FS;

  let runDir: string;
  let target: string;
  try {
    runDir = await fs.realpath(join(runsRoot, runId));
  } catch {
    throw new ArtifactAccessError('not_found', entry.id);
  }
  try {
    target = await fs.realpath(join(runDir, ...normalized.split('/')));
  } catch {
    throw new ArtifactAccessError('not_found', entry.id);
  }
  if (!isInside(runDir, target)) throw new ArtifactAccessError('outside_run', entry.id);
  const resolvedRel = relative(runDir, target).split(sep).join('/');
  // A link must land on a file of the same entry: never a denied file, and
  // never a file the host would label with another entry's media type.
  if (classifyRunArtifact(resolvedRel).id !== entry.id) {
    throw new ArtifactAccessError('not_public', entry.id);
  }

  let info: { isFile(): boolean; size: number; mtime: Date };
  try {
    info = await fs.stat(target);
  } catch {
    throw new ArtifactAccessError('not_found', entry.id);
  }
  if (!info.isFile()) throw new ArtifactAccessError('not_found', entry.id);
  if (
    options.requireInline === true &&
    entry.inline_cap_bytes !== null &&
    info.size > entry.inline_cap_bytes
  ) {
    throw new ArtifactAccessError('too_large', entry.id);
  }
  return { absPath: target, relPath: normalized, entry, bytes: info.size, mtime: info.mtime };
}
