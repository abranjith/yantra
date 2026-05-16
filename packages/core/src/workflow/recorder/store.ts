/**
 * FileSystemRecordingStore — persistence layer for recording artifacts.
 *
 * Implements `RecordingStore` using `fs/promises` and atomic writes.
 * Phase 2 will introduce `SqliteRecordingStore` that keeps the same interface.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RecordingDraftSchema } from '@yantra/protocol';
import type { CapturedAction, RecordingDraft } from '@yantra/protocol';

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

/**
 * Maps `recordingId` → partial action list in-memory for fast appends.
 * Persisted to `draft.partial.json` after each append.
 */
interface PartialState {
  actions: CapturedAction[];
  recordingDir: string;
}

export class FileSystemRecordingStore implements RecordingStore {
  private readonly cacheRoot: string;
  private readonly partials = new Map<string, PartialState>();

  /**
   * @param cacheRoot - Root directory for recording dirs, e.g. `~/.cache/yantra`
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

    await mkdir(profileDir, { recursive: true });

    this.partials.set(recordingId, { actions: [], recordingDir: dir });

    return { recordingDir: dir, profileDir };
  }

  /** @inheritdoc */
  async appendAction(recordingId: string, action: CapturedAction): Promise<void> {
    let state = this.partials.get(recordingId);
    if (!state) {
      // Re-hydrate if process restarted mid-session (rare)
      const dir = this.recordingDir(recordingId);
      state = { actions: [], recordingDir: dir };
      this.partials.set(recordingId, state);
    }

    state.actions.push(action);
    await this.writePartial(state);
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

    await writeFileAtomic(draftPath, content);

    // Remove the partial draft (replaced by final)
    const partialPath = join(dir, 'draft.partial.json');
    await rm(partialPath, { force: true });

    // Clean up in-memory state
    this.partials.delete(recordingId);

    return draftPath;
  }

  /** @inheritdoc */
  async loadDraft(recordingId: string): Promise<RecordingDraft> {
    const { readFile } = await import('node:fs/promises');
    const draftPath = join(this.recordingDir(recordingId), 'draft.json');
    const raw = await readFile(draftPath, 'utf8');
    const json: unknown = JSON.parse(raw);
    return RecordingDraftSchema.parse(json);
  }

  /** @inheritdoc */
  async destroy(recordingId: string, opts: { keepProfile: boolean }): Promise<void> {
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

    this.partials.delete(recordingId);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async writePartial(state: PartialState): Promise<void> {
    const partialPath = join(state.recordingDir, 'draft.partial.json');
    const content = JSON.stringify({ actions: state.actions }, null, 2);
    await writeFileAtomic(partialPath, content);
  }
}

/**
 * Atomic write: write to `<path>.tmp` then rename to `<path>`.
 * Prevents half-written files on crash.
 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}
