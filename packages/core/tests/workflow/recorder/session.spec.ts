/**
 * TASK-008/009/013: RecordingSession state machine and lifecycle tests.
 *
 * These tests mock the browser/CDP layer to avoid needing a real Chrome.
 * Tagged @no-llm — must pass with LLM_PROVIDER=none.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CapturedAction, RecordingDraft } from '@yantra/protocol';
import { describe, afterEach, beforeEach, expect, it } from 'vitest';

import { assembleDraft } from '../../../src/workflow/recorder/draft-builder.js';
import { DefaultCaptureRedactor } from '../../../src/workflow/recorder/redactor.js';
import { FileSystemRecordingStore } from '../../../src/workflow/recorder/store.js';

// ---------------------------------------------------------------------------
// Lightweight store stub that avoids real filesystem in unit tests
// ---------------------------------------------------------------------------

// Kept for reference; tests use FileSystemRecordingStore directly. The
// underscore prefix satisfies the unused-vars convention.
class _InMemoryStore implements InstanceType<typeof FileSystemRecordingStore> {
  private actions = new Map<string, CapturedAction[]>();
  private drafts = new Map<string, RecordingDraft>();
  private dirs = new Map<string, { recordingDir: string; profileDir: string }>();
  private tmpRoot: string;

  constructor(root: string) {
    this.tmpRoot = root;
  }

  recordingDir(id: string): string {
    return join(this.tmpRoot, `recording-${id}`);
  }

  async create(id: string, _hint: string) {
    const rDir = this.recordingDir(id);
    const pDir = join(rDir, 'profile');
    this.dirs.set(id, { recordingDir: rDir, profileDir: pDir });
    this.actions.set(id, []);
    return { recordingDir: rDir, profileDir: pDir };
  }

  async appendAction(id: string, action: CapturedAction) {
    const list = this.actions.get(id) ?? [];
    list.push(action);
    this.actions.set(id, list);
  }

  async saveDraft(id: string, draft: RecordingDraft): Promise<string> {
    this.drafts.set(id, draft);
    return join(this.recordingDir(id), 'draft.json');
  }

  async loadDraft(id: string): Promise<RecordingDraft> {
    const d = this.drafts.get(id);
    if (!d) throw new Error(`no draft for ${id}`);
    return d;
  }

  async destroy(_id: string, _opts: { keepProfile: boolean }) {
    // no-op in tests
  }

  getActions(id: string): CapturedAction[] {
    return this.actions.get(id) ?? [];
  }

  getDraft(id: string): RecordingDraft | undefined {
    return this.drafts.get(id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClickAction(url = 'https://example.com'): CapturedAction {
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
    url_before: url,
    url_after: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('@no-llm assembleDraft integration with store', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'yantra-session-test-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('assembleDraft produces a draft that store can save and load', async () => {
    const store = new FileSystemRecordingStore(tmpRoot);
    const redactor = new DefaultCaptureRedactor();

    const id = 'SESS001';
    await store.create(id, 'test-wf');

    const action = makeClickAction();
    const redacted = redactor.redact(action);
    await store.appendAction(id, redacted);

    const draft = assembleDraft({
      recordingId: id,
      workflowNameHint: 'test-wf',
      startedAt: '2026-05-11T12:00:00.000Z',
      stoppedAt: '2026-05-11T12:05:00.000Z',
      stopReason: 'user',
      actions: [redacted],
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

    await store.saveDraft(id, draft);
    const loaded = await store.loadDraft(id);

    expect(loaded.recording_id).toBe(id);
    expect(loaded.stop_reason).toBe('user');
    expect(loaded.actions).toHaveLength(1);
    expect(loaded.actions[0]?.kind).toBe('click');
  });

  it('redactor output is persisted without raw values', async () => {
    const store = new FileSystemRecordingStore(tmpRoot);
    const redactor = new DefaultCaptureRedactor();

    const id = 'SESS002';
    await store.create(id, 'login-wf');

    const rawFill = {
      kind: 'fill' as const,
      element_descriptor: {
        tag: 'input',
        role: 'textbox' as const,
        accessible_name: 'Password',
        visible_text: null,
        attrs_sample: { type: 'password' },
        bounding_rect: { x: 0, y: 0, width: 200, height: 30 },
        in_iframe: false,
        xpath_for_debug: '/html/body/input',
      },
      candidate_chain: [],
      ts: new Date().toISOString(),
      url_before: 'https://example.com',
      url_after: null,
      raw_value: 'my-actual-password',
      value_length: 18,
      input_type: 'password' as const,
    };

    const redacted = redactor.redact(rawFill);
    await store.appendAction(id, redacted);

    const draft = assembleDraft({
      recordingId: id,
      workflowNameHint: 'login-wf',
      startedAt: '2026-05-11T12:00:00.000Z',
      stoppedAt: '2026-05-11T12:05:00.000Z',
      stopReason: 'user',
      actions: [redacted],
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

    await store.saveDraft(id, draft);
    const loaded = await store.loadDraft(id);
    const draftStr = JSON.stringify(loaded);

    // The actual password must not appear anywhere in the serialized draft
    expect(draftStr).not.toContain('my-actual-password');

    const fillAction = loaded.actions.find((a) => a.kind === 'fill');
    expect(fillAction).toBeDefined();
    if (fillAction?.kind === 'fill') {
      expect(fillAction.raw_value).toBe('<redacted>');
      expect(fillAction.value_length).toBe(18);
    }
  });
});

// ---------------------------------------------------------------------------
// State machine validation (pure logic, no browser)
// ---------------------------------------------------------------------------

describe('@no-llm RecordingSession state guard', () => {
  it('start() throws when called in non-idle state (double-start)', async () => {
    // We test this by directly checking the state guard in session.ts
    // rather than launching a real browser — this tests the guard logic in isolation

    // Create a minimal session that fails early without a browser
    const { RecordingSession } = await import('../../../src/workflow/recorder/session.js');
    const session = new RecordingSession();

    // Force internal state to 'recording' via reflection to test the guard
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).state = 'recording';

    await expect(session.start('test')).rejects.toThrow(/invalid state/i);
  });

  it('stop() throws when called in idle state', async () => {
    const { RecordingSession } = await import('../../../src/workflow/recorder/session.js');
    const session = new RecordingSession();

    await expect(session.stop('user')).rejects.toThrow(/invalid state/i);
  });
});
