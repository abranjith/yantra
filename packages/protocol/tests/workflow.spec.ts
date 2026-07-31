import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { WorkflowFile, WorkflowSynthesis } from '../src/index.js';

import { makeWorkflow } from './factories.js';

describe('@no-llm workflow schema', () => {
  it('applies defaults for optional fields', () => {
    const parsed = WorkflowFile.parse({
      version: 1,
      name: 'example',
      description: null,
      security_class: 'public',
      steps: [
        {
          id: 's1',
          scope: null,
          verb: 'navigate',
          url: 'https://example.com',
        },
      ],
    });

    expect(parsed.outputs_unredacted).toBe(false);
    expect(parsed._unrecorded_frames).toEqual([]);
    expect(parsed.recorded_with).toBeNull();
    expect(parsed.synthesis).toBeNull();
  });

  it('parses a hand-written bank statement workflow fixture', () => {
    expect(WorkflowFile.safeParse(makeWorkflow()).success).toBe(true);
  });

  it('accepts recorded_with null and populated object', () => {
    fc.assert(
      fc.property(fc.boolean(), (includeRecordedWith) => {
        const workflow = makeWorkflow({
          recorded_with: includeRecordedWith
            ? { chrome_major: 124, yantra_version: '0.1.0' }
            : null,
        });

        expect(WorkflowFile.safeParse(workflow).success).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});

describe('@no-llm workflow synthesis block', () => {
  it('leaves synthesis null on a fixture that does not declare it (back-compat)', () => {
    const { synthesis: _omitted, ...withoutSynthesis } = makeWorkflow();

    const parsed = WorkflowFile.parse(withoutSynthesis);

    expect(parsed.synthesis).toBeNull();
  });

  it('applies length, detail, and use_llm defaults when only goal is given', () => {
    const parsed = WorkflowFile.parse({
      ...makeWorkflow(),
      synthesis: { goal: 'What did the statement show?' },
    });

    expect(parsed.synthesis).toEqual({
      goal: 'What did the statement show?',
      length: 'medium',
      detail: 'standard',
      // Model-free unless the workflow says otherwise: declaring a Brief must
      // never be the same act as opting into a provider session.
      use_llm: false,
    });
  });

  it('accepts explicit length and detail values', () => {
    const parsed = WorkflowSynthesis.parse({ goal: 'g', length: 'long', detail: 'full' });

    expect(parsed).toEqual({ goal: 'g', length: 'long', detail: 'full', use_llm: false });
  });

  it('accepts an explicit use_llm opt-in', () => {
    const parsed = WorkflowSynthesis.parse({ goal: 'g', use_llm: true });

    expect(parsed).toEqual({ goal: 'g', length: 'medium', detail: 'standard', use_llm: true });
  });

  it('rejects a non-boolean use_llm', () => {
    expect(WorkflowSynthesis.safeParse({ goal: 'g', use_llm: 'yes' }).success).toBe(false);
  });

  it('parses a pre-use_llm workflow with the block model-free (back-compat)', () => {
    // Every workflow saved before the field existed must keep replaying exactly
    // as it did — which means deterministically.
    const parsed = WorkflowFile.parse(
      makeWorkflow({ synthesis: { goal: 'g', length: 'short', detail: 'overview' } }),
    );

    expect(parsed.synthesis?.use_llm).toBe(false);
  });

  it('rejects an empty goal', () => {
    expect(WorkflowSynthesis.safeParse({ goal: '' }).success).toBe(false);
  });

  it('rejects a goal over 512 characters', () => {
    expect(WorkflowSynthesis.safeParse({ goal: 'x'.repeat(512) }).success).toBe(true);
    expect(WorkflowSynthesis.safeParse({ goal: 'x'.repeat(513) }).success).toBe(false);
  });

  it('rejects unknown length and detail values', () => {
    expect(WorkflowSynthesis.safeParse({ goal: 'g', length: 'huge' }).success).toBe(false);
    expect(WorkflowSynthesis.safeParse({ goal: 'g', detail: 'everything' }).success).toBe(false);
  });

  it('accepts an explicit null synthesis block', () => {
    const parsed = WorkflowFile.parse(makeWorkflow({ synthesis: null }));

    expect(parsed.synthesis).toBeNull();
  });
});
