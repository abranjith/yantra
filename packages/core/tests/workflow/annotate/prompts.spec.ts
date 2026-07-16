// @no-llm
import type { RecordingDraft, WorkflowFile } from '@yantra/protocol';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { AnnotateSession } from '../../../src/workflow/annotate/session.js';
import type { WorkflowStore } from '../../../src/workflow/store.types.js';

// The interactive flow imports `prompts` directly (no DI seam), so we replace
// the module with a fake that answers each prompt from a per-test queue,
// keyed by the prompt's `name` — mirroring the real library's return shape.
const { answers } = vi.hoisted(() => ({ answers: { queue: [] as unknown[] } }));

vi.mock('prompts', () => {
  const fn = async (question: { name: string }): Promise<Record<string, unknown>> => {
    return { [question.name]: answers.queue.shift() };
  };
  return { default: Object.assign(fn, { override: () => undefined, inject: () => undefined }) };
});

// Import AFTER the mock is registered so the flow binds to the fake `prompts`.
const { runAnnotatePrompts } = await import('../../../src/workflow/annotate/prompts.js');

/** A recording whose single annotatable action is a purchase-shaped click. */
function makeClickDraft(accessibleName: string): RecordingDraft {
  return {
    schema_version: '0.1',
    recording_id: '01HXYZ1234567890ABCDEFGHIJ',
    workflow_name_hint: 'checkout',
    started_at: '2026-04-15T09:00:00.000Z',
    stopped_at: '2026-04-15T09:05:00.000Z',
    stop_reason: 'user',
    actions: [
      {
        kind: 'click',
        ts: '2026-04-15T09:00:05.000Z',
        url_before: 'https://shop.example.com/cart',
        url_after: null,
        element_descriptor: {
          tag: 'button',
          role: 'button',
          accessible_name: accessibleName,
          visible_text: accessibleName,
          attrs_sample: {},
          bounding_rect: { x: 100, y: 200, width: 120, height: 44 },
          in_iframe: false,
          xpath_for_debug: '//button',
        },
        candidate_chain: [
          {
            candidate: { kind: 'role', role: 'button', name: accessibleName },
            score: 0.98,
            rank_reason: 'ARIA role match',
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
      initial_url: 'https://shop.example.com/cart',
      capture_count: 1,
      dwell_per_page: [],
      stop_reason: 'user',
      unrecorded_frame_origins: [],
    },
  };
}

/** A WorkflowStore that captures the saved workflow instead of writing to disk. */
function makeCapturingStore(): { store: WorkflowStore; saved: () => WorkflowFile | null } {
  let captured: WorkflowFile | null = null;
  const store: WorkflowStore = {
    load: () => Promise.reject(new Error('load not used in annotate flow')),
    save: (workflow) => {
      captured = workflow;
      return Promise.resolve();
    },
    list: () => Promise.resolve([]),
    listCatalog: () => Promise.resolve([]),
    delete: () => Promise.resolve(),
    exists: () => Promise.resolve(false),
  };
  return { store, saved: () => captured };
}

describe('runAnnotatePrompts — requires_confirmation prompt (FEAT-019)', () => {
  beforeEach(() => {
    answers.queue = [];
  });

  it('flags a kept click when the user answers yes to the confirmation prompt', async () => {
    const session = new AnnotateSession(makeClickDraft('Buy now'), 'checkout', 'public');
    const { store, saved } = makeCapturingStore();

    // select=keep, locator name, confirm=yes, save=yes
    answers.queue = ['keep', 'Buy button', true, true];
    await runAnnotatePrompts(session, store);

    const workflow = saved();
    expect(workflow).not.toBeNull();
    const clickStep = workflow?.steps.find((s) => s.verb === 'click');
    expect(clickStep?.requires_confirmation).toBe(true);
  });

  it('leaves a kept click unflagged when the user answers no', async () => {
    const session = new AnnotateSession(makeClickDraft('Buy now'), 'checkout', 'public');
    const { store, saved } = makeCapturingStore();

    // Even for a purchase-shaped click, an explicit "no" wins over the heuristic.
    answers.queue = ['keep', 'Buy button', false, true];
    await runAnnotatePrompts(session, store);

    const clickStep = saved()?.steps.find((s) => s.verb === 'click');
    expect(clickStep?.requires_confirmation).toBe(false);
  });

  it('defaults the confirmation prompt from the purchase-shaped heuristic', async () => {
    // A bare Enter on the confirm prompt yields undefined, so the flow must fall
    // back to the heuristic — true for a purchase-shaped "Place order" click.
    const session = new AnnotateSession(makeClickDraft('Place order'), 'checkout', 'public');
    const { store, saved } = makeCapturingStore();

    answers.queue = ['keep', 'Order button', undefined, true];
    await runAnnotatePrompts(session, store);

    const clickStep = saved()?.steps.find((s) => s.verb === 'click');
    expect(clickStep?.requires_confirmation).toBe(true);
  });

  it('skipped actions never reach the confirmation prompt and produce no steps', async () => {
    const session = new AnnotateSession(makeClickDraft('Buy now'), 'checkout', 'public');
    const { store, saved } = makeCapturingStore();

    // select=skip, save=yes — no locator or confirm prompt is consumed.
    answers.queue = ['skip', true];
    await runAnnotatePrompts(session, store);

    expect(saved()?.steps).toHaveLength(0);
  });
});
