/**
 * Read-only listing of retained FEAT-064 ownership records whose process
 * identity verdict is `unknown` (FEAT-071 TASK-009).
 *
 * This module never signals, terminates, or deletes any process or file.
 * Malformed records fail per item, never per list.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  OwnedBrowserEvent,
  RunLease,
  UNKNOWN_START_TOKEN_VALUE,
  type PossibleOrphan,
} from '@yantra/protocol';

import type { ProcessIdentity, ProcessLivenessProbe } from '../browser/installation-types.js';
import { runsRoot } from '../browser/paths.js';
import { NodeProcessLivenessProbe } from '../browser/process-identity.js';
import { OWNED_BROWSERS_FILENAME, RUN_LEASE_FILENAME } from '../run-ownership/constants.js';
import { leaseOwner } from '../run-ownership/lease-store.js';

export interface ReadPossibleOrphansOptions {
  readonly root?: string;
  readonly probe?: ProcessLivenessProbe;
}

/** Reduces a POSIX or Windows executable path to its basename. */
function executableBasename(rawPath: string): string {
  const parts = rawPath.trim().split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? rawPath.trim();
}

function optionalExecutable(raw: unknown, fallback: string): string {
  if (typeof raw === 'object' && raw !== null && 'executable' in raw) {
    const candidate = (raw as { executable?: unknown }).executable;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return executableBasename(candidate);
    }
  }
  return fallback;
}

interface ParsedOwnedBrowser {
  readonly identity: ProcessIdentity;
  readonly recordedAt: string;
  readonly executable: string;
}

async function readOutstandingBrowsersSafe(runDir: string): Promise<ParsedOwnedBrowser[]> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, OWNED_BROWSERS_FILENAME), 'utf8');
  } catch {
    return [];
  }

  const lines = raw.split('\n');
  lines.pop(); // empty after final newline, or a partial trailing line
  const outstanding = new Map<string, ParsedOwnedBrowser>();

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const executable = optionalExecutable(json, 'browser');
    const candidate =
      typeof json === 'object' && json !== null && 'executable' in json
        ? (() => {
            const { executable: _ignored, ...rest } = json as Record<string, unknown>;
            return rest;
          })()
        : json;
    const parsed = OwnedBrowserEvent.safeParse(candidate);
    if (!parsed.success) continue;

    const key = `${String(parsed.data.pid)}:${parsed.data.start_token}`;
    if (parsed.data.op === 'spawned') {
      outstanding.set(key, {
        identity: { pid: parsed.data.pid, startToken: parsed.data.start_token },
        recordedAt: parsed.data.at,
        executable,
      });
    } else {
      outstanding.delete(key);
    }
  }

  return [...outstanding.values()];
}

/**
 * Lists retained ownership records whose process identity cannot be verified
 * (`verdict === 'unknown'`). Read-only: never signals or deletes anything.
 */
export async function readPossibleOrphans(
  options: ReadPossibleOrphansOptions = {},
): Promise<PossibleOrphan[]> {
  const root = options.root ?? runsRoot();
  const probe = options.probe ?? new NodeProcessLivenessProbe();

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: PossibleOrphan[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = join(root, entry.name);

    let rawLeaseJson: unknown;
    try {
      const rawText = await readFile(join(runDir, RUN_LEASE_FILENAME), 'utf8');
      rawLeaseJson = JSON.parse(rawText);
    } catch {
      continue;
    }

    const leaseParsed = RunLease.safeParse(rawLeaseJson);
    if (!leaseParsed.success) continue;
    const lease = leaseParsed.data;

    let ownerVerdict: 'alive' | 'dead' | 'unknown';
    try {
      ownerVerdict = await probe.check(leaseOwner(lease));
    } catch {
      continue;
    }

    if (ownerVerdict === 'unknown') {
      out.push({
        run_id: lease.run_id,
        pid: lease.owner.pid,
        recorded_start_token_present:
          lease.owner.start_token !== UNKNOWN_START_TOKEN_VALUE &&
          lease.owner.start_token.length > 0,
        executable: optionalExecutable(rawLeaseJson, 'yantra'),
        recorded_at: lease.claimed_at,
        reason: 'identity_unverifiable',
      });
      continue;
    }

    if (ownerVerdict === 'dead') {
      const browsers = await readOutstandingBrowsersSafe(runDir);
      for (const browser of browsers) {
        let browserVerdict: 'alive' | 'dead' | 'unknown';
        try {
          browserVerdict = await probe.check(browser.identity);
        } catch {
          continue;
        }
        if (browserVerdict === 'unknown') {
          out.push({
            run_id: lease.run_id,
            pid: browser.identity.pid,
            recorded_start_token_present:
              browser.identity.startToken !== UNKNOWN_START_TOKEN_VALUE &&
              browser.identity.startToken.length > 0,
            executable: browser.executable,
            recorded_at: browser.recordedAt,
            reason: 'identity_unverifiable',
          });
        }
      }
    }
  }

  return out;
}
