// @no-llm
/**
 * `translate()` carries the workflow's declared synthesis intent through to the
 * orchestrator (FEAT-FP-001, TASK-004). By the time the Synthesize stage runs
 * the `WorkflowFile` is out of scope, so the spec has to ride along on the
 * translation result.
 */

import type { WorkflowFile, WorkflowSynthesis } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../src/workflow/replay/workflow-to-plan.js';

function makeWorkflow(overrides: Partial<WorkflowFile> = {}): WorkflowFile {
  return {
    version: 1,
    name: 'synthesis-fixture',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [
      {
        id: 's1',
        verb: 'extract',
        scope: null,
        locator: 'Body',
        extraction_schema: { type: 'primitive', kind: 'readable' },
        capture_as: 'body',
      },
    ],
    outputs: [],
    synthesis: null,
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: { Body: [{ kind: 'label', value: 'Body' }] },
    ...overrides,
  } as WorkflowFile;
}

describe('@no-llm translate() synthesisSpec', () => {
  it('carries a declared synthesis block through unchanged', () => {
    const synthesis: WorkflowSynthesis = {
      goal: 'What did the page report?',
      length: 'long',
      detail: 'full',
    };

    const translated = translate(makeWorkflow({ synthesis }), {});

    expect(translated.synthesisSpec).toEqual(synthesis);
  });

  it('reports null for a workflow that declares no synthesis', () => {
    const translated = translate(makeWorkflow(), {});

    expect(translated.synthesisSpec).toBeNull();
  });

  it('leaves the rest of the translation untouched', () => {
    const withSynthesis = translate(
      makeWorkflow({ synthesis: { goal: 'g', length: 'short', detail: 'overview' } }),
      {},
    );
    const without = translate(makeWorkflow(), {});

    expect(withSynthesis.plan.steps).toEqual(without.plan.steps);
    expect(withSynthesis.outputBindings).toEqual(without.outputBindings);
    expect(withSynthesis.profileSpec).toEqual(without.profileSpec);
    expect(withSynthesis.declaredSecretKeys).toEqual(without.declaredSecretKeys);
  });
});
