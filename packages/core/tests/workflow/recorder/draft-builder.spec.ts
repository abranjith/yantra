/**
 * TASK-009: Draft builder tests.
 *
 * Tests assembleDraft and computeDwellPerPage.
 * Tagged @no-llm — must pass with LLM_PROVIDER=none.
 */

import { describe, expect, it } from 'vitest';

import type { CapturedAction, RecordingMetadata } from '@yantra/protocol';

import { assembleDraft, computeDwellPerPage } from '../../../src/workflow/recorder/draft-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return {
    start_ts: '2026-05-11T12:00:00.000Z',
    end_ts: '2026-05-11T12:05:00.000Z',
    os: { platform: 'linux', release: '5.15.0', arch: 'x64' },
    chrome_version: '124.0.6367.91',
    chrome_major: 124,
    yantra_version: '0.1.0',
    initial_url: 'https://example.com',
    capture_count: 0,
    dwell_per_page: [],
    stop_reason: 'user',
    unrecorded_frame_origins: [],
    ...overrides,
  };
}

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
    ts: '2026-05-11T12:01:00.000Z',
    url_before: url,
    url_after: null,
  };
}

function makeNavigateAction(from: string, to: string): CapturedAction {
  return {
    kind: 'navigate',
    ts: '2026-05-11T12:02:00.000Z',
    url_before: from,
    url_after: to,
    navigation_kind: 'user_click',
    triggered_by_action_index: 0,
  };
}

function makeFillAction(): CapturedAction {
  return {
    kind: 'fill',
    element_descriptor: {
      tag: 'input',
      role: 'textbox',
      accessible_name: 'Email',
      visible_text: null,
      attrs_sample: { type: 'email' },
      bounding_rect: { x: 0, y: 0, width: 200, height: 30 },
      in_iframe: false,
      xpath_for_debug: '/html/body/input',
    },
    candidate_chain: [],
    ts: '2026-05-11T12:01:30.000Z',
    url_before: 'https://example.com',
    url_after: null,
    raw_value: '<redacted>',
    value_length: 15,
    input_type: 'email',
  };
}

// ---------------------------------------------------------------------------
// assembleDraft
// ---------------------------------------------------------------------------

describe('@no-llm assembleDraft', () => {
  it('produces a valid RecordingDraft with schema_version 0.1', () => {
    const draft = assembleDraft({
      recordingId: 'REC001',
      workflowNameHint: 'test-workflow',
      startedAt: '2026-05-11T12:00:00.000Z',
      stoppedAt: '2026-05-11T12:05:00.000Z',
      stopReason: 'user',
      actions: [makeClickAction()],
      metadata: makeMetadata(),
    });

    expect(draft.schema_version).toBe('0.1');
    expect(draft.recording_id).toBe('REC001');
    expect(draft.workflow_name_hint).toBe('test-workflow');
    expect(draft.stop_reason).toBe('user');
  });

  it('embeds the correct capture_count in metadata', () => {
    const actions = [makeClickAction(), makeFillAction()];
    const draft = assembleDraft({
      recordingId: 'REC002',
      workflowNameHint: 'wf',
      startedAt: '2026-05-11T12:00:00.000Z',
      stoppedAt: '2026-05-11T12:05:00.000Z',
      stopReason: 'user',
      actions,
      metadata: makeMetadata({ capture_count: 0 }), // will be overridden
    });

    expect(draft.metadata.capture_count).toBe(2);
  });

  it('sets stop_reason to crash for abort', () => {
    const draft = assembleDraft({
      recordingId: 'REC003',
      workflowNameHint: 'wf',
      startedAt: '2026-05-11T12:00:00.000Z',
      stoppedAt: '2026-05-11T12:01:00.000Z',
      stopReason: 'crash',
      actions: [],
      metadata: makeMetadata({ stop_reason: 'crash' }),
    });

    expect(draft.stop_reason).toBe('crash');
  });

  it('allows an empty actions array (crash with no captures)', () => {
    const draft = assembleDraft({
      recordingId: 'REC004',
      workflowNameHint: 'wf',
      startedAt: '2026-05-11T12:00:00.000Z',
      stoppedAt: '2026-05-11T12:00:01.000Z',
      stopReason: 'crash',
      actions: [],
      metadata: makeMetadata({ stop_reason: 'crash' }),
    });

    expect(draft.actions).toHaveLength(0);
  });

  it('throws when recording_id is empty', () => {
    expect(() =>
      assembleDraft({
        recordingId: '',
        workflowNameHint: 'wf',
        startedAt: '2026-05-11T12:00:00.000Z',
        stoppedAt: '2026-05-11T12:05:00.000Z',
        stopReason: 'user',
        actions: [],
        metadata: makeMetadata(),
      }),
    ).toThrow();
  });

  it('includes fill actions with raw_value: "<redacted>"', () => {
    const draft = assembleDraft({
      recordingId: 'REC005',
      workflowNameHint: 'login-wf',
      startedAt: '2026-05-11T12:00:00.000Z',
      stoppedAt: '2026-05-11T12:05:00.000Z',
      stopReason: 'user',
      actions: [makeFillAction()],
      metadata: makeMetadata(),
    });

    const fill = draft.actions.find((a) => a.kind === 'fill');
    expect(fill).toBeDefined();
    if (fill?.kind === 'fill') {
      expect(fill.raw_value).toBe('<redacted>');
    }
  });
});

// ---------------------------------------------------------------------------
// computeDwellPerPage
// ---------------------------------------------------------------------------

describe('@no-llm computeDwellPerPage', () => {
  it('returns empty array for no actions', () => {
    expect(computeDwellPerPage([])).toEqual([]);
  });

  it('returns one entry for all actions on the same URL', () => {
    const actions: CapturedAction[] = [
      {
        ...makeClickAction('https://example.com'),
        ts: '2026-05-11T12:00:00.000Z',
      },
      {
        ...makeClickAction('https://example.com'),
        ts: '2026-05-11T12:00:05.000Z',
      },
    ];
    const dwell = computeDwellPerPage(actions);
    expect(dwell).toHaveLength(1);
    expect(dwell[0]?.url).toBe('https://example.com');
    expect(dwell[0]?.ms).toBe(5000);
  });

  it('returns separate entries for different URLs', () => {
    const actions: CapturedAction[] = [
      {
        ...makeClickAction('https://example.com'),
        ts: '2026-05-11T12:00:00.000Z',
      },
      makeNavigateAction('https://example.com', 'https://example.com/dashboard'),
      {
        ...makeClickAction('https://example.com/dashboard'),
        ts: '2026-05-11T12:00:10.000Z',
      },
    ];
    const dwell = computeDwellPerPage(actions);
    const urls = dwell.map((d) => d.url);
    expect(urls).toContain('https://example.com');
    expect(urls).toContain('https://example.com/dashboard');
  });

  it('dwell time is non-negative for single-action URLs', () => {
    const actions: CapturedAction[] = [makeClickAction('https://example.com')];
    const dwell = computeDwellPerPage(actions);
    expect(dwell.every((d) => d.ms >= 0)).toBe(true);
  });
});
