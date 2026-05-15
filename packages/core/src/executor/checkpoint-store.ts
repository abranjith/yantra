import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Checkpoint, CheckpointStore, CheckpointSummary } from './types.js';

const SCHEMA_VERSION = '0.1';

/**
 * Filesystem-backed checkpoint store.
 *
 * Each checkpoint is written atomically: first to `<step-id>.json.tmp`,
 * then renamed to `<step-id>.json`. On POSIX and NTFS (same volume), rename
 * is atomic so a crash mid-write never leaves a partial file visible.
 */
export class FilesystemCheckpointStore implements CheckpointStore {
  constructor(private readonly dir: string) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const filename = `${checkpoint.after_step_id}.json`;
    const tmpPath = join(this.dir, `${filename}.tmp`);
    const finalPath = join(this.dir, filename);
    const content = JSON.stringify({ ...checkpoint, schema_version: SCHEMA_VERSION }, null, 2);
    await writeFile(tmpPath, content, 'utf8');
    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort cleanup of the .tmp on rename failure
      await writeFile(tmpPath + '.dead', '', 'utf8').catch(() => undefined);
      throw err;
    }
  }

  async load(stepId: string): Promise<Checkpoint | null> {
    const path = join(this.dir, `${stepId}.json`);
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }

  async list(): Promise<CheckpointSummary[]> {
    try {
      const entries = await readdir(this.dir);
      const summaries: CheckpointSummary[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;
        try {
          const raw = await readFile(join(this.dir, entry), 'utf8');
          const checkpoint = JSON.parse(raw) as Checkpoint;
          summaries.push({
            step_id: checkpoint.after_step_id,
            ts: checkpoint.ts,
            after_step_idx: checkpoint.after_step_idx,
          });
        } catch {
          // Skip corrupted checkpoint files
        }
      }
      return summaries.sort((a, b) => a.after_step_idx - b.after_step_idx);
    } catch {
      return [];
    }
  }

  async loadLast(): Promise<Checkpoint | null> {
    const summaries = await this.list();
    if (summaries.length === 0) return null;
    const last = summaries[summaries.length - 1];
    if (!last) return null;
    return this.load(last.step_id);
  }
}
