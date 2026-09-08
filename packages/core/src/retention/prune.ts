import { readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { YantraConfig } from '../config/schema.js';

export interface PruneRetentionOptions {
  readonly config: YantraConfig;
  readonly runsPath: string;
  readonly indexPath: string;
  readonly now?: number;
}

/** Best-effort retention pruning. Individual filesystem failures never escape. */
export async function pruneRetention(options: PruneRetentionOptions): Promise<void> {
  await Promise.all([
    pruneRuns(options.runsPath, options.config.retention.runs_days, options.now ?? Date.now()),
    pruneCorruptIndexes(options.indexPath, options.config.retention.corrupt_index_keep),
  ]);
}

async function pruneRuns(root: string, days: number, now: number): Promise<void> {
  if (days === 0) return;
  const cutoff = now - days * 86_400_000;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(root, entry.name);
        try {
          if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
        } catch {
          // Retention is best-effort; locked and unreadable runs remain intact.
        }
      }),
  );
}

async function pruneCorruptIndexes(indexPath: string, keep: number): Promise<void> {
  const root = dirname(indexPath);
  const prefix = `${basename(indexPath)}.corrupt.`;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
        .map(async (entry) => {
          const path = join(root, entry.name);
          return { path, mtimeMs: (await stat(path)).mtimeMs };
        }),
    );
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(candidates.slice(keep).map(async ({ path }) => rm(path, { force: true })));
  } catch {
    // Corrupt-index cleanup must not make index startup fatal.
  }
}
