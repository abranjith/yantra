import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateSemantics, validateWorkflowSemantics } from '../src/index.js';

import { makePlan, makeWorkflow } from './factories.js';

describe('@no-llm semantic validator', () => {
  it('returns actionable errors for cross-reference failures', () => {
    const plan = makePlan({
      default_scope: 'read-only-data',
      steps: [
        {
          id: 's1',
          scope: null,
          type: 'fill',
          locator: { kind: 'workflow', name: 'Missing locator' },
          value: { kind: 'capture', step_id: 's2', field: null },
          submit: false,
        },
        {
          id: 's2',
          scope: null,
          type: 'extract',
          locator: { kind: 'workflow', name: 'Transactions table' },
          extraction_schema: {
            type: 'object',
            fields: { amount: { type: 'primitive', kind: 'number' } },
          },
          capture_as: 'transactions',
        },
      ],
    });

    const result = validateSemantics(plan, {
      workflowLocators: ['Transactions table'],
      workflowSecrets: ['bank.password'],
    });

    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error.map((entry) => entry.path)).toContain('/steps/0/type');
      expect(result.error.map((entry) => entry.path)).toContain('/steps/0/value/step_id');
      expect(result.error.map((entry) => entry.path)).toContain('/steps/0/locator');
    }
  });

  it('rejects mutating verbs in read-only-data scope', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('navigate', 'click', 'fill', 'assert', 'branch', 'loop', 'call_workflow'),
        (verb) => {
          const baseStep = {
            id: 's1',
            scope: 'read-only-data' as const,
          };

          const stepByVerb = {
            navigate: {
              ...baseStep,
              type: 'navigate',
              url: { kind: 'literal', value: 'https://example.com' },
            },
            click: {
              ...baseStep,
              type: 'click',
              locator: { kind: 'workflow', name: 'x' },
              modifiers: null,
            },
            fill: {
              ...baseStep,
              type: 'fill',
              locator: { kind: 'workflow', name: 'x' },
              value: { kind: 'literal', value: 'x' },
              submit: false,
            },
            assert: {
              ...baseStep,
              type: 'assert',
              locator: { kind: 'workflow', name: 'x' },
              condition: { kind: 'visible' },
            },
            branch: {
              ...baseStep,
              type: 'branch',
              condition: { kind: 'always' },
              then_step_id: 's1',
              else_step_id: null,
            },
            loop: {
              ...baseStep,
              type: 'loop',
              over: { kind: 'param', key: 'items' },
              as: 'item',
              body_step_ids: ['s1'],
              max_iterations: 2,
            },
            call_workflow: {
              ...baseStep,
              type: 'call_workflow',
              workflow_name: 'child',
              params: {},
              capture_as: null,
            },
          } as const;

          const plan = makePlan({
            default_scope: 'public',
            steps: [stepByVerb[verb]],
          });

          const result = validateSemantics(plan);
          expect(result.isOk).toBe(false);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('never throws on malformed capture targets', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (stepCount) => {
        const steps = Array.from({ length: stepCount }, (_, index) => ({
          id: `s${index + 1}`,
          scope: null,
          type: 'llm_summarize' as const,
          input: { kind: 'capture' as const, step_id: `s${stepCount + 2}`, field: null },
          prompt: 'Summarize',
          output_as: 'summary',
        }));

        const plan = makePlan({ steps });
        expect(() => validateSemantics(plan)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('validates workflow references and warnings', () => {
    const workflow = makeWorkflow({
      outputs_unredacted: true,
      security_class: 'authenticated',
      _unrecorded_frames: ['https://frame.example'],
      steps: [
        {
          id: 's1',
          scope: null,
          verb: 'fill',
          locator: 'Missing locator',
          value: '{{ secret:bank.username }}',
          submit: false,
        },
      ],
      secrets: ['bank.password'],
      params: {},
      _locators: {},
    });

    const result = validateWorkflowSemantics(workflow);
    expect(result.result.isOk).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
