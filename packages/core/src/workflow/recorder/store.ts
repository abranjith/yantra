/**
 * FileSystemRecordingStore — persistence layer for recording artifacts.
 *
 * Implements `RecordingStore` using `fs/promises` and atomic writes.
 * Phase 2 will introduce `SqliteRecordingStore` that keeps the same interface.
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CapturedActionSchema, RecordingDraftSchema } from '@yantra/protocol';
import type { CapturedAction, RecordingDraft } from '@yantra/protocol';

import { writeFileAtomic } from '../../fs/atomic-write.js';
import { withResourceLock } from '../../locks/resource-lock.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface RecordingStore {
  /**
   * Create the recording dir and profile dir. Idempotent on retry.
   *
   * @returns Paths to the created directories
   */
  create(
    recordingId: string,
    workflowNameHint: string,
  ): Promise<{ recordingDir: string; profileDir: string }>;

  /**
   * Append a captured action to the partial draft. Writes atomically.
   * Accepts only post-redaction `CapturedAction` (never raw input).
   */
  appendAction(recordingId: string, action: CapturedAction): Promise<void>;

  /**
   * Finalize: validate the full draft against the Zod schema, write
   * `draft.json` atomically, and return its absolute path.
   *
   * @throws {Error} when Zod validation fails
   */
  saveDraft(recordingId: string, draft: RecordingDraft): Promise<string>;

  /**
   * Read a draft from disk for FEAT-009 consumption. Validates on load.
   *
   * @throws {Error} when the draft file is missing or fails validation
   */
  loadDraft(recordingId: string): Promise<RecordingDraft>;

  /**
   * Destroy the recording dir, including the profile, unless `keepProfile`.
   * Best-effort — does not throw if files are already gone.
   */
  destroy(recordingId: string, opts: { keepProfile: boolean }): Promise<void>;

  /** Returns the absolute path to the recording directory. */
  recordingDir(recordingId: string): string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class FileSystemRecordingStore implements RecordingStore {
  private readonly cacheRoot: string;

  /**
   * @param cacheRoot - Root directory for recording dirs, e.g. `~/.yantra/cache`
   */
  constructor(cacheRoot: string) {
    this.cacheRoot = cacheRoot;
  }

  /** @inheritdoc */
  recordingDir(recordingId: string): string {
    return join(this.cacheRoot, `recording-${recordingId}`);
  }

  /** @inheritdoc */
  async create(
    recordingId: string,
    _workflowNameHint: string,
  ): Promise<{ recordingDir: string; profileDir: string }> {
    const dir = this.recordingDir(recordingId);
    const profileDir = join(dir, 'profile');

    await this.withRecordingLock(recordingId, async () => {
      await mkdir(profileDir, { recursive: true });
    });

    return { recordingDir: dir, profileDir };
  }

  /** @inheritdoc */
  async appendAction(recordingId: string, action: CapturedAction): Promise<void> {
    await this.withRecordingLock(recordingId, async () => {
      const dir = this.recordingDir(recordingId);
      await stat(dir);
      const path = join(dir, 'draft.partial.json');
      let actions: CapturedAction[];
      try {
        const partial = JSON.parse(await readFile(path, 'utf8')) as { actions: unknown };
        actions = CapturedActionSchema.array().parse(partial.actions);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        actions = [];
      }
      actions.push(action);
      await writeFileAtomic(path, JSON.stringify({ actions }, null, 2));
    });
  }

  /** @inheritdoc */
  async saveDraft(recordingId: string, draft: RecordingDraft): Promise<string> {
    // Validate against Zod schema before writing
    const parseResult = RecordingDraftSchema.safeParse(draft);
    if (!parseResult.success) {
      throw new Error(
        `RecordingDraft validation failed: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    const dir = this.recordingDir(recordingId);
    const draftPath = join(dir, 'draft.json');
    const content = JSON.stringify(parseResult.data, null, 2);

    return await this.withRecordingLock(recordingId, async () => {
      await stat(dir);
      await writeFileAtomic(draftPath, content);

      // Remove the partial draft (replaced by final)
      const partialPath = join(dir, 'draft.partial.json');
      await rm(partialPath, { force: true });

      return draftPath;
    });
  }

  /** @inheritdoc */
  async loadDraft(recordingId: string): Promise<RecordingDraft> {
    const draftPath = join(this.recordingDir(recordingId), 'draft.json');
    const raw = await readFile(draftPath, 'utf8');
    const json: unknown = JSON.parse(raw);
    return RecordingDraftSchema.parse(json);
  }

  /** @inheritdoc */
  async destroy(recordingId: string, opts: { keepProfile: boolean }): Promise<void> {
    await this.withRecordingLock(recordingId, async () => {
      const dir = this.recordingDir(recordingId);

      if (opts.keepProfile) {
        // Destroy everything except the profile subdir
        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(dir).catch(() => [] as string[]);
        await Promise.all(
          entries
            .filter((e) => e !== 'profile')
            .map((e) => rm(join(dir, e), { recursive: true, force: true })),
        );
      } else {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async withRecordingLock<T>(recordingId: string, fn: () => Promise<T>): Promise<T> {
    // A sibling lock survives destroy() removing the recording directory itself.
    return await withResourceLock({ kind: 'workflow', name: recordingId.toLowerCase() }, fn, {
      targetPath: this.recordingDir(recordingId),
    });
  }
}
