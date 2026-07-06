// @no-llm
import type { RecordingDraft } from '@yantra/protocol';
import { describe, it, expect } from 'vitest';

import { AnnotateSession } from '../../../src/workflow/annotate/session.js';

function makeDraft(overrides: Partial<RecordingDraft> = {}): RecordingDraft {
  return {
    schema_version: '0.1',
    recording_id: '01HXYZ1234567890ABCDEFGHIJ',
    workflow_name_hint: 'test-workflow',
    started_at: '2026-04-15T09:00:00.000Z',
    stopped_at: '2026-04-15T09:05:00.000Z',
    stop_reason: 'user',
    actions: [
      {
        kind: 'navigate',
        ts: '2026-04-15T09:00:01.000Z',
        url_before: 'about:blank',
        url_after: 'https://example.com',
        navigation_kind: 'address_bar',
        triggered_by_action_index: null,
      },
      {
        kind: 'click',
        ts: '2026-04-15T09:00:05.000Z',
        url_before: 'https://example.com',
        url_after: null,
        element_descriptor: {
          tag: 'button',
          role: 'button',
          accessible_name: 'Sign in',
          visible_text: 'Sign in',
          attrs_sample: { 'aria-label': 'Sign in' },
          bounding_rect: { x: 100, y: 200, width: 120, height: 44 },
          in_iframe: false,
          xpath_for_debug: '//button',
        },
        candidate_chain: [
          {
            candidate: { kind: 'role', role: 'button', name: 'Sign in' },
            score: 0.98,
            rank_reason: 'ARIA role match',
          },
        ],
      },
      {
        kind: 'fill',
        ts: '2026-04-15T09:00:10.000Z',
        url_before: 'https://example.com',
        url_after: null,
        raw_value: '<redacted>',
        value_length: 10,
        input_type: 'password',
        element_descriptor: {
          tag: 'input',
          role: 'textbox',
          accessible_name: 'Password',
          visible_text: null,
          attrs_sample: { type: 'password', name: 'password' },
          bounding_rect: { x: 100, y: 260, width: 300, height: 40 },
          in_iframe: false,
          xpath_for_debug: '//input[@name="password"]',
        },
        candidate_chain: [
          {
            candidate: { kind: 'label', value: 'Password' },
            score: 0.95,
            rank_reason: 'label match',
          },
        ],
      },
    ],
    metadata: {
      start_ts: '2026-04-15T09:00:00.000Z',
      end_ts: '2026-04-15T09:05:00.000Z',
      os: { platform: 'linux', release: '5.15.0', arch: 'x64' },
      chrome_version: '124.0.6367.91',
      chrome_major: 124,
      yantra_version: '0.1.0',
      initial_url: 'https://example.com',
      capture_count: 3,
      dwell_per_page: [{ url: 'https://example.com', ms: 5000 }],
      stop_reason: 'user',
      unrecorded_frame_origins: [],
    },
    ...overrides,
  };
}

describe('AnnotateSession state machine', () => {
  it('starts in reviewing state at index 0', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    const state = session.getState();
    expect(state.kind).toBe('reviewing');
    if (state.kind === 'reviewing') {
      expect(state.index).toBe(0);
    }
  });

  it('current() returns a view with the first annotatable action', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    const view = session.current();
    expect(view).not.toBeNull();
    if (view) {
      expect(view.index).toBe(0);
      expect(view.total).toBe(3);
      expect(view.capturedAction.kind).toBe('navigate');
    }
  });

  it('next() advances to the next action', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    session.next();
    const state = session.getState();
    expect(state.kind).toBe('reviewing');
    if (state.kind === 'reviewing') {
      expect(state.index).toBe(1);
    }
  });

  it('back() returns to previous action', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    session.next();
    session.back();
    const state = session.getState();
    expect(state.kind).toBe('reviewing');
    if (state.kind === 'reviewing') {
      expect(state.index).toBe(0);
    }
  });

  it('back() at index 0 stays at 0', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    session.back();
    const state = session.getState();
    expect(state.kind).toBe('reviewing');
    if (state.kind === 'reviewing') {
      expect(state.index).toBe(0);
    }
  });

  it('next() after last action transitions to preview', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    session.next();
    session.next();
    session.next();
    const state = session.getState();
    expect(state.kind).toBe('preview');
  });

  it('cancel() transitions to cancelled state', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    session.cancel();
    expect(session.getState().kind).toBe('cancelled');
  });

  it('skipAll() skips remaining actions and transitions to preview', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    session.skipAll();
    expect(session.getState().kind).toBe('preview');
  });

  it('acceptAll() keeps remaining with defaults and transitions to preview', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    session.acceptAll();
    expect(session.getState().kind).toBe('preview');
  });

  it('confirm() from preview transitions to confirm', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    session.goToPreview();
    session.confirm();
    expect(session.getState().kind).toBe('confirm');
  });

  it('current() returns null when not in reviewing state', () => {
    const session = new AnnotateSession(makeDraft(), 'test-wf', 'public');
    session.goToPreview();
    expect(session.current()).toBeNull();
  });
});

describe('AnnotateSession.assemble()', () => {
  it('produces a workflow with steps from kept decisions', () => {
    const session = new AnnotateSession(makeDraft(), 'bank-test', 'authenticated');

    // Keep navigate and click, skip fill
    session.applyDecision({
      draftActionId: '0',
      action: 'keep',
      locatorName: null,
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });
    session.next();

    session.applyDecision({
      draftActionId: '1',
      action: 'keep',
      locatorName: 'Sign in button',
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });
    session.next();

    session.applyDecision({
      draftActionId: '2',
      action: 'skip',
      locatorName: null,
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });

    const workflow = session.assemble();
    expect(workflow.name).toBe('bank-test');
    expect(workflow.security_class).toBe('authenticated');
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps[0]?.verb).toBe('navigate');
    expect(workflow.steps[1]?.verb).toBe('click');
  });

  it('carries recorded_with from draft metadata', () => {
    const session = new AnnotateSession(makeDraft(), 'test', 'public');
    session.acceptAll();
    const workflow = session.assemble();
    expect(workflow.recorded_with).not.toBeNull();
    if (workflow.recorded_with) {
      expect(workflow.recorded_with.chrome_major).toBe(124);
      expect(workflow.recorded_with.yantra_version).toBe('0.1.0');
    }
  });

  it('carries _unrecorded_frames from draft metadata', () => {
    const draft = makeDraft({
      metadata: {
        start_ts: '2026-04-15T09:00:00.000Z',
        end_ts: '2026-04-15T09:05:00.000Z',
        os: { platform: 'linux', release: '5.15.0', arch: 'x64' },
        chrome_version: '124.0.6367.91',
        chrome_major: 124,
        yantra_version: '0.1.0',
        initial_url: 'https://example.com',
        capture_count: 3,
        dwell_per_page: [],
        stop_reason: 'user',
        unrecorded_frame_origins: ['https://third-party.example'],
      },
    });
    const session = new AnnotateSession(draft, 'test', 'public');
    session.acceptAll();
    const workflow = session.assemble();
    expect(workflow._unrecorded_frames).toEqual(['https://third-party.example']);
  });

  it('sets cookies:auto when URL contains "login"', () => {
    const session = new AnnotateSession(makeDraft(), 'test', 'public');
    session.acceptAll();
    const workflow = session.assemble();
    // Navigate action has url_after https://example.com (no login)
    // cookies should be 'none'
    expect(workflow.cookies).toBe('none');
  });

  it('declares param when fill decision promotes to param', () => {
    const session = new AnnotateSession(makeDraft(), 'test', 'public');

    // Skip navigate
    session.applyDecision({
      draftActionId: '0',
      action: 'skip',
      locatorName: null,
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });
    session.next();

    // Skip click
    session.applyDecision({
      draftActionId: '1',
      action: 'skip',
      locatorName: null,
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });
    session.next();

    // Keep fill, promote to param
    session.applyDecision({
      draftActionId: '2',
      action: 'keep',
      locatorName: 'Password field',
      valuePromotion: 'param',
      paramOrSecretKey: 'user_password',
      scopeOverride: null,
      requiresConfirmation: false,
    });

    const workflow = session.assemble();
    expect(Object.keys(workflow.params)).toContain('user_password');
  });

  it('declares secret when fill decision promotes to secret', () => {
    const session = new AnnotateSession(makeDraft(), 'test', 'public');

    session.applyDecision({
      draftActionId: '0',
      action: 'skip',
      locatorName: null,
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });
    session.next();

    session.applyDecision({
      draftActionId: '1',
      action: 'skip',
      locatorName: null,
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });
    session.next();

    session.applyDecision({
      draftActionId: '2',
      action: 'keep',
      locatorName: 'Password field',
      valuePromotion: 'secret',
      paramOrSecretKey: 'bank.password',
      scopeOverride: null,
      requiresConfirmation: false,
    });

    const workflow = session.assemble();
    expect(workflow.secrets).toContain('bank.password');
  });

  it('auto-assigns step IDs starting from s1', () => {
    const session = new AnnotateSession(makeDraft(), 'test', 'public');
    session.acceptAll();
    const workflow = session.assemble();
    const ids = workflow.steps.map((s) => s.id);
    expect(ids[0]).toBe('s1');
    if (ids.length > 1) expect(ids[1]).toBe('s2');
    if (ids.length > 2) expect(ids[2]).toBe('s3');
  });
});

// A recording whose single annotatable action is a purchase-shaped click,
// used to exercise the requires_confirmation heuristic (FEAT-019 TASK-005).
function makePurchaseClickDraft(): RecordingDraft {
  return makeDraft({
    actions: [
      {
        kind: 'click',
        ts: '2026-04-15T09:00:05.000Z',
        url_before: 'https://shop.example.com/cart',
        url_after: null,
        element_descriptor: {
          tag: 'button',
          role: 'button',
          accessible_name: 'Buy now',
          visible_text: 'Buy now',
          attrs_sample: {},
          bounding_rect: { x: 100, y: 200, width: 120, height: 44 },
          in_iframe: false,
          xpath_for_debug: '//button',
        },
        candidate_chain: [
          {
            candidate: { kind: 'role', role: 'button', name: 'Buy now' },
            score: 0.98,
            rank_reason: 'ARIA role match',
          },
        ],
      },
    ],
  });
}

describe('AnnotateSession requires_confirmation propagation (FEAT-019)', () => {
  it('carries requiresConfirmation:true from a kept click decision into the assembled step', () => {
    const session = new AnnotateSession(makeDraft(), 'test', 'public');

    // Skip navigate, keep+flag the click, skip fill.
    session.applyDecision({
      draftActionId: '0',
      action: 'skip',
      locatorName: null,
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });
    session.next();

    session.applyDecision({
      draftActionId: '1',
      action: 'keep',
      locatorName: 'Sign in button',
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: true,
    });
    session.next();

    session.applyDecision({
      draftActionId: '2',
      action: 'skip',
      locatorName: null,
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });

    const clickStep = session.assemble().steps.find((s) => s.verb === 'click');
    expect(clickStep?.requires_confirmation).toBe(true);
  });

  it('carries requiresConfirmation:false from a kept click decision into the assembled step', () => {
    const session = new AnnotateSession(makeDraft(), 'test', 'public');

    session.applyDecision({
      draftActionId: '0',
      action: 'skip',
      locatorName: null,
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });
    session.next();

    session.applyDecision({
      draftActionId: '1',
      action: 'keep',
      locatorName: 'Sign in button',
      valuePromotion: null,
      paramOrSecretKey: null,
      scopeOverride: null,
      requiresConfirmation: false,
    });

    const clickStep = session.assemble().steps.find((s) => s.verb === 'click');
    expect(clickStep?.requires_confirmation).toBe(false);
  });

  it('acceptAll() flags purchase-shaped clicks via the heuristic', () => {
    const session = new AnnotateSession(makePurchaseClickDraft(), 'shop', 'public');
    session.acceptAll();
    const clickStep = session.assemble().steps.find((s) => s.verb === 'click');
    expect(clickStep?.requires_confirmation).toBe(true);
  });

  it('acceptAll() leaves ordinary (non-purchase) clicks unflagged', () => {
    const session = new AnnotateSession(makeDraft(), 'test', 'public');
    session.acceptAll();
    const clickStep = session.assemble().steps.find((s) => s.verb === 'click');
    expect(clickStep?.requires_confirmation).toBe(false);
  });

  it('skipAll() produces no confirmable steps (all actions skipped)', () => {
    const session = new AnnotateSession(makeDraft(), 'test', 'public');
    session.skipAll();
    expect(session.assemble().steps).toHaveLength(0);
  });
});
