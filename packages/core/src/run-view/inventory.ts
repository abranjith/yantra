/**
 * The public file inventory of one run directory (FEAT-066 TASK-004).
 *
 * A depth-2 walk (the run directory and its direct subdirectories such as
 * `agent/`, `screenshots/` and `captures/`), classified against
 * `RUN_ARTIFACT_REGISTRY`. Denied files are omitted entirely, so the
 * inventory never names them. Links are never followed: a symlinked or
 * junctioned entry is skipped, since its target may lie outside the run.
 */

import { lstat as fsLstat, readdir as fsReaddir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  RUN_INVENTORY_MAX_ITEMS,
  classifyRunArtifact,
  type ArtifactInventoryItem,
} from '@yantra/protocol';

/** The filesystem calls the walk makes; injected in tests. */
export interface InventoryFs {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtime: Date;
  }>;
}

/** Node's `fs/promises`. */
export const NODE_INVENTORY_FS: InventoryFs = {
  readdir: (path) => fsReaddir(path),
  lstat: (path) => fsLstat(path),
};

/** The inventory and whether it stopped at its cap. */
export interface RunInventory {
  readonly items: readonly ArtifactInventoryItem[];
  readonly truncated: boolean;
}

/**
 * Lists the public files of `runDir`, sorted by path, at most `cap` of them.
 */
export async function listRunArtifacts(
  runDir: string,
  options: { readonly cap?: number; readonly fs?: InventoryFs } = {},
): Promise<RunInventory> {
  const fs = options.fs ?? NODE_INVENTORY_FS;
  const cap = options.cap ?? RUN_INVENTORY_MAX_ITEMS;
  const items: ArtifactInventoryItem[] = [];
  let truncated = false;

  const visit = async (relDir: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (
        await fs.readdir(relDir === '' ? runDir : join(runDir, ...relDir.split('/')))
      ).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated) return;
      const relPath = relDir === '' ? name : `${relDir}/${name}`;
      let info: Awaited<ReturnType<InventoryFs['lstat']>>;
      try {
        info = await fs.lstat(join(runDir, ...relPath.split('/')));
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (depth < 1) await visit(relPath, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      const entry = classifyRunArtifact(relPath);
      if (entry.exposure === 'denied') continue;
      if (items.length >= cap) {
        truncated = true;
        return;
      }
      items.push({
        path: relPath,
        entry_id: entry.id,
        exposure: entry.exposure,
        viewer: entry.viewer,
        bytes: info.size,
        modified_at: info.mtime.toISOString(),
        over_inline_cap: entry.inline_cap_bytes !== null && info.size > entry.inline_cap_bytes,
      });
    }
  };

  await visit('', 0);
  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { items, truncated };
}
