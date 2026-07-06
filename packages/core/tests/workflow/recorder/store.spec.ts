/**
 * Store tests — atomic write, partial flush, load/save, destroy.
 *
 * Tagged @no-llm — must pass with LLM_PROVIDER=none.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CapturedAction } from '@yantra/protocol';
import { describe, afterEach, beforeEach, expect, it } from 'vitest';

import { assembleDraft } from '../../../src/workflow/recorder/draft-builder.js';
import { FileSystemRecordingStore } from '../../../src/workflow/recorder/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClickAction(): CapturedAction {
  return {
    kind: 'click',
    element_descriptor: {
      tag: 'button',
      role: 'button',
      accessible_name: 'Submit',
      visible_text: 'Submit',
      attrs_sample: {},
      bounding_rect: { x: 0, y: 0, width: 100, height: 40 },
      in_iframe: false,
      xpath_for_debug: '/html/body/button',
    },
    candidate_chain: [],
    ts: new Date().toISOString(),
    url_before: 'https://example.com',
    url_after: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('@no-llm FileSystemRecordingStore', () => {
  let tmpRoot: string;
  let store: FileSystemRecordingStore;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'yantra-store-test-'));
    store = new FileSystemRecordingStore(tmpRoot);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('creates the recording dir and profile dir', async () => {
    const { recordingDir, profileDir } = await store.create('REC001', 'test-wf');
    await expect(stat(recordingDir)).resolves.toBeDefined();
    await expect(stat(profileDir)).resolves.toBeDefined();
  });

  it('appendAction writes a parseable draft.partial.json', async () => {
    await store.create('REC002', 'wf');
    const action = makeClickAction();
    await store.appendAction('REC002', action);

    const partialPath = join(store.recordingDir('REC002'), 'draft.partial.json');
    const raw = await readFile(partialPath, 'utf8');
    const parsed = JSON.parse(raw) as { actions: CapturedAction[] };
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]!.kind).toBe('click');
  });

  it('appendAction accumulates multiple actions', async () => {
    await store.create('REC003', 'wf');
    await store.appendAction('REC003', makeClickAction());
    await store.appendAction('REC003', makeClickAction());
    await store.appendAction('REC003', makeClickAction());

    const partialPath = join(store.recordingDir('REC003'), 'draft.partial.json');
    const raw = await readFile(partialPath, 'utf8');
    const parsed = JSON.parse(raw) as { actions: CapturedAction[] };
    expect(parsed.actions).toHaveLength(3);
  });

  it('saveDraft writes a valid draft.json and removes draft.partial.json', async () => {
    await store.create('REC004', 'wf');
    const action = makeClickAction();
    await store.appendAction('REC004', action);

    const draft = assembleDraft({
      recordingId: 'REC004',
      workflowNameHint: 'wf',
      startedAt: '2026-05-11T12:00:00.000Z',
      stoppedAt: '2026-05-11T12:05:00.000Z',
      stopReason: 'user',
      actions: [action],
      metadata: {
        start_ts: '2026-05-11T12:00:00.000Z',
        end_ts: '2026-05-11T12:05:00.000Z',
        os: { platform: 'linux', release: '5.15.0', arch: 'x64' },
        chrome_version: '124.0.0.0',
        chrome_major: 124,
        yantra_version: '0.1.0',
        initial_url: 'https://example.com',
        capture_count: 1,
        dwell_per_page: [],
        stop_reason: 'user',
        unrecorded_frame_origins: [],
      },
    });

    const draftPath = await store.saveDraft('REC004', draft);
    await expect(stat(draftPath)).resolves.toBeDefined();

    // Partial should be gone
    const partialPath = join(store.recordingDir('REC004'), 'draft.partial.json');
    await expect(stat(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loadDraft reads and validates a saved draft', async () => {
    await store.create('REC005', 'wf');
    const action = makeClickAction();
    await store.appendAction('REC005', action);

    const draft = assembleDraft({
      recordingId: 'REC005',
      workflowNameHint: 'wf',
      startedAt: '2026-05-11T12:00:00.000Z',
      stoppedAt: '2026-05-11T12:05:00.000Z',
      stopReason: 'user',
      actions: [action],
      metadata: {
        start_ts: '2026-05-11T12:00:00.000Z',
        end_ts: '2026-05-11T12:05:00.000Z',
        os: { platform: 'linux', release: '5.15.0', arch: 'x64' },
        chrome_version: '124.0.0.0',
        chrome_major: 124,
        yantra_version: '0.1.0',
        initial_url: 'https://example.com',
        capture_count: 1,
        dwell_per_page: [],
        stop_reason: 'user',
        unrecorded_frame_origins: [],
      },
    });

    await store.saveDraft('REC005', draft);
    const loaded = await store.loadDraft('REC005');
    expect(loaded.recording_id).toBe('REC005');
    expect(loaded.actions).toHaveLength(1);
  });

  it('destroy removes the entire recording dir by default', async () => {
    await store.create('REC006', 'wf');
    const dir = store.recordingDir('REC006');
    await store.destroy('REC006', { keepProfile: false });
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('destroy with keepProfile=true preserves the profile subdir', async () => {
    const { profileDir } = await store.create('REC007', 'wf');
    await store.destroy('REC007', { keepProfile: true });
    // Profile dir should still exist
    await expect(stat(profileDir)).resolves.toBeDefined();
  });

  it('saveDraft throws when draft fails schema validation', async () => {
    await store.create('REC008', 'wf');
    // Corrupt the draft by passing invalid schema_version
    const badDraft = {
      schema_version: '9.9', // invalid — not a supported schema version
      recording_id: 'REC008',
      workflow_name_hint: 'wf',
      started_at: '2026-05-11T12:00:00.000Z',
      stopped_at: '2026-05-11T12:05:00.000Z',
      stop_reason: 'user',
      actions: [],
      metadata: {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(store.saveDraft('REC008', badDraft as any)).rejects.toThrow();
  });
});
