// @no-llm
/**
 * `--save-as` carries synthesis intent (FEAT-FP-001, TASK-008).
 *
 * A workflow promoted from a run that published a Brief must keep producing that
 * document on replay. Before this, promotion collapsed the trailing read into one
 * `extract` and bound its first row to an output — the published Brief was lost,
 * so `yantra run <promoted>` reported a raw scrape where `yantra do` had answered
 * a question.
 *
 * `maybePromoteTrace` is exercised directly: the only providers that populate the
 * trace are the real browser tools, which the seam-level fake never invokes.
 */

import type { WorkflowStore } from '@yantra/core';
import type { WorkflowFile } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  maybePromoteTrace,
  type AgenticRunEnvironment,
  type AgenticTaskRequest,
} from '../../src/runtime/orchestrator.js';
import type { AgenticTaskOutcome } from '../../src/runtime/outcome.js';
import { AgentTrace } from '../../src/runtime/trace.js';

function recordingStore(): WorkflowStore & { readonly saved: WorkflowFile[] } {
  const saved: WorkflowFile[] = [];
  return {
    saved,
    load: vi.fn(),
    list: vi.fn(() => Promise.resolve([])),
    listCatalog: vi.fn(() => Promise.resolve([])),
    delete: vi.fn(),
    exists: vi.fn(() => Promise.resolve(false)),
    save: vi.fn((workflow: WorkflowFile) => {
      saved.push(workflow);
      return Promise.resolve();
    }),
  } as unknown as WorkflowStore & { readonly saved: WorkflowFile[] };
}

/** A trace with one navigate plus a terminal content read — the promotable shape. */
function populatedTrace(): AgentTrace {
  const trace = new AgentTrace();
  trace.append({
    kind: 'navigate',
    host: 'shop.example',
    url: 'https://shop.example/orders',
    requires_confirmation: false,
  });
  trace.append({
    kind: 'extract',
    host: 'shop.example',
    extractionKind: 'content',
    requires_confirmation: false,
  });
  return trace;
}

const published: AgenticTaskOutcome = {
  kind: 'published',
  runId: 'run-1',
  runDir: '/runs/run-1',
  brief: { briefId: 'b1', jsonPath: '/runs/run-1/brief.json' } as never,
};

function request(overrides: Partial<AgenticTaskRequest> = {}): AgenticTaskRequest {
  return {
    goal: 'When will my package arrive?',
    model: { provider: 'fixture', id: 'fixture-model' },
    auth: { mode: 'managed' },
    connector: {} as never,
    ...overrides,
  } as AgenticTaskRequest;
}

function environment(store?: WorkflowStore): AgenticRunEnvironment {
  return {
    browserController: { teardown: vi.fn() },
    ...(store === undefined ? {} : { workflowStore: store }),
    domain: {} as never,
  } as unknown as AgenticRunEnvironment;
}

describe('@no-llm maybePromoteTrace synthesis intent', () => {
  it('carries the run goal into the promoted workflow synthesis block', async () => {
    const store = recordingStore();

    const outcome = await maybePromoteTrace({
      request: request({ saveAs: 'package-eta' }),
      environment: environment(store),
      trace: populatedTrace(),
      outcome: published,
    });

    expect(outcome).toMatchObject({ promotion: { saved: true, workflowName: 'package-eta' } });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.synthesis).toEqual({
      goal: 'When will my package arrive?',
      length: 'medium',
      detail: 'standard',
      // A model wrote this run's Brief, so the workflow says so — that is what
      // lets `yantra run package-eta` reproduce it with no mode flag.
      use_llm: true,
    });
  });

  it('records use_llm because a published Brief is always model-authored', async () => {
    // Reaching promotion means the agent published; the agent *is* the model.
    // Promoting without this would save a workflow that quietly produces a
    // plainer document than the run the user just watched succeed.
    const store = recordingStore();

    await maybePromoteTrace({
      request: request({ saveAs: 'package-eta' }),
      environment: environment(store),
      trace: populatedTrace(),
      outcome: published,
    });

    expect(store.saved[0]?.synthesis?.use_llm).toBe(true);
  });

  it('still records the trailing extract and its output alongside the block', async () => {
    // The Brief is an addition, not a replacement: the raw capture stays
    // available for anything downstream that consumed the output before.
    const store = recordingStore();

    await maybePromoteTrace({
      request: request({ saveAs: 'package-eta' }),
      environment: environment(store),
      trace: populatedTrace(),
      outcome: published,
    });

    const saved = store.saved[0];
    expect(saved?.steps.some((step) => step.verb === 'extract')).toBe(true);
    expect(saved?.outputs.length).toBeGreaterThan(0);
    expect(saved?.synthesis).not.toBeNull();
  });

  it('promotes nothing when the run published nothing', async () => {
    // An unpublished run had no synthesis step to reproduce, so it must not
    // declare a block promising a document it was never shown how to produce.
    const store = recordingStore();

    const outcome = await maybePromoteTrace({
      request: request({ saveAs: 'package-eta' }),
      environment: environment(store),
      trace: populatedTrace(),
      outcome: { kind: 'failed', runId: 'r', runDir: '/r', error: { code: 'X', message: 'no' } },
    });

    expect(store.saved).toEqual([]);
    expect(outcome).not.toHaveProperty('promotion');
  });

  it('promotes nothing without --save-as', async () => {
    const store = recordingStore();

    const outcome = await maybePromoteTrace({
      request: request(),
      environment: environment(store),
      trace: populatedTrace(),
      outcome: published,
    });

    expect(store.saved).toEqual([]);
    expect(outcome).toBe(published);
  });

  it('reports a best-effort failure without changing the published outcome', async () => {
    const outcome = await maybePromoteTrace({
      request: request({ saveAs: 'package-eta' }),
      environment: environment(undefined),
      trace: populatedTrace(),
      outcome: published,
    });

    expect(outcome?.kind).toBe('published');
    expect(outcome).toMatchObject({ promotion: { saved: false } });
  });

  it('keeps a store save failure from failing the published run', async () => {
    const store = recordingStore();
    (store.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));

    const outcome = await maybePromoteTrace({
      request: request({ saveAs: 'package-eta' }),
      environment: environment(store),
      trace: populatedTrace(),
      outcome: published,
    });

    expect(outcome?.kind).toBe('published');
    expect(outcome).toMatchObject({ promotion: { saved: false } });
  });

  it('trims a padded goal before storing it', async () => {
    const store = recordingStore();

    await maybePromoteTrace({
      request: request({ saveAs: 'package-eta', goal: '   padded goal   ' }),
      environment: environment(store),
      trace: populatedTrace(),
      outcome: published,
    });

    expect(store.saved[0]?.synthesis?.goal).toBe('padded goal');
  });
});
