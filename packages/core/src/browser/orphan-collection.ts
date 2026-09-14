/** Safe exact-child cleanup for managed installation orphans. */
import { lstat, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import type { ManagedStateReader } from './installation-types.js';
import type { OrphanCollectionReport } from './managed-install-types.js';
import { canonicalize } from './managed-state.js';
import { managedBrowsersRoot } from './paths.js';

export interface OrphanCollectorDeps {
  readonly state: ManagedStateReader;
  readonly root?: () => string;
  readonly remove?: typeof rm;
  readonly canonicalize?: typeof canonicalize;
}
export class OrphanCollector {
  private readonly state: ManagedStateReader;
  private readonly root: () => string;
  private readonly remove: typeof rm;
  private readonly canonical: typeof canonicalize;
  constructor(deps: OrphanCollectorDeps) {
    this.state = deps.state;
    this.root = deps.root ?? managedBrowsersRoot;
    this.remove = deps.remove ?? rm;
    this.canonical = deps.canonicalize ?? canonicalize;
  }
  async collect(): Promise<OrphanCollectionReport> {
    const inventory = await this.state.readInventory();
    let attempted = 0,
      deleted = 0,
      bytesReclaimed = 0,
      skippedLiveOwner = 0;
    const failed: { cacheRootRelative: string; reason: string }[] = [];
    for (const orphan of inventory.orphans) {
      if (orphan.hasLiveOwner) {
        skippedLiveOwner++;
        continue;
      }
      attempted++;
      try {
        await this.deleteExact(
          orphan.cacheRootRelative,
          inventory.ready.status === 'ready' ? inventory.ready.record.cacheRootRelative : null,
        );
        deleted++;
        bytesReclaimed += orphan.bytes;
      } catch (error) {
        failed.push({
          cacheRootRelative: orphan.cacheRootRelative,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { attempted, deleted, bytesReclaimed, skippedLiveOwner, failed };
  }
  private async deleteExact(name: string, ready: string | null): Promise<void> {
    if (!/^installation-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))
      throw new Error('Refusing to delete a non-installation managed child.');
    if (name === ready) throw new Error('Refusing to delete the ready managed installation.');
    const root = resolve(this.root()),
      target = resolve(root, name);
    if (relative(root, target) !== name)
      throw new Error('Refusing to delete a path outside the managed browser root.');
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      this.canonical(root),
      this.canonical(target),
    ]);
    if (
      canonicalRoot === null ||
      canonicalTarget === null ||
      relative(canonicalRoot, canonicalTarget).startsWith('..')
    )
      throw new Error('Refusing to delete a symlink or junction escape.');
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Refusing to delete a non-directory managed child.');
    await this.remove(target, { recursive: true, force: false, maxRetries: 2 });
  }
}
