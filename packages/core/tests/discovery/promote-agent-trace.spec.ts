// @no-llm
import type { WorkflowFile } from '@yantra/protocol';
import { WorkflowFile as WorkflowFileSchema } from '@yantra/protocol';
import { describe, it, expect, vi } from 'vitest';

import { promoteAgentTrace, type PromotableTraceStep } from '../../src/discovery/promote.js';
import { lint } from '../../src/workflow/lint/index.js';
import { WorkflowCollisionError } from '../../src/workflow/store.js';
import type { WorkflowStore } from '../../src/workflow/store.types.js';

function makeFakeStore(
  opts: { existingNames?: Set<string> } = {},
): WorkflowStore & { saved: WorkflowFile[] } {
  const existing = opts.existingNames ?? new Set<string>();
  const saved: WorkflowFile[] = [];
  return {
    saved,
    load: vi.fn(),
    list: vi.fn(async () => []),
    listCatalog: vi.fn(async () => []),
    delete: vi.fn(),
    exists: vi.fn(async (name: string) => existing.has(name)),
    save: vi.fn(async (workflow: WorkflowFile, saveOpts) => {
      if (existing.has(workflow.name) && saveOpts?.force !== true) {
        throw new WorkflowCollisionError(workflow.name);
      }
      saved.push(workflow);
    }),
  };
}

const navigate: PromotableTraceStep = {
  kind: 'navigate',
  host: 'shop.example',
  url: 'https://shop.example/login',
  requires_confirmation: false,
};

describe('@no-llm promoteAgentTrace', () => {
  it('promotes a fill+click+extract trace into a valid, lint-clean workflow', async () => {
    const store = makeFakeStore();
    const steps: PromotableTraceStep[] = [
      navigate,
      {
        kind: 'fill',
        host: 'shop.example',
        locator: [{ kind: 'role', role: 'textbox', name: 'Email' }],
        value: { kind: 'literal', value: 'ada@example.com' },
        submit: false,
        requires_confirmation: false,
      },
      {
        kind: 'click',
        host: 'shop.example',
        locator: [{ kind: 'role', role: 'button', name: 'Continue' }],
        requires_confirmation: false,
      },
      {
        kind: 'extract',
        host: 'shop.example',
        extractionKind: 'content',
        requires_confirmation: false,
      },
    ];

    const result = await promoteAgentTrace(steps, { workflowName: 'shop-login', store });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // Schema-valid.
    expect(() => WorkflowFileSchema.parse(result.value)).not.toThrow();
    // Semantic/lint-clean (strict).
    expect(lint(result.value, { strict: true }).errors).toHaveLength(0);
    // Steps preserved in order.
    expect(result.value.steps.map((s) => s.verb)).toEqual(['navigate', 'fill', 'click', 'extract']);
    expect(store.saved).toHaveLength(1);
  });

  it('promotes a secret fill into a declared SecretRef reference (never a value)', async () => {
    const store = makeFakeStore();
    const steps: PromotableTraceStep[] = [
      navigate,
      {
        kind: 'fill',
        host: 'shop.example',
        locator: [{ kind: 'role', role: 'textbox', name: 'Password' }],
        value: { kind: 'secret_ref', key: 'shop.password' },
        submit: true,
        requires_confirmation: true,
      },
    ];

    const result = await promoteAgentTrace(steps, { workflowName: 'secret-login', store });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // The secret key is declared and the fill references it, not a raw value.
    expect(result.value.secrets).toContain('shop.password');
    const fill = result.value.steps.find((s) => s.verb === 'fill');
    expect(fill).toBeDefined();
    if (fill?.verb === 'fill') {
      expect(fill.value).toBe('{{ secret:shop.password }}');
    }
    // A workflow with secrets is classified authenticated.
    expect(result.value.security_class).toBe('authenticated');
    expect(lint(result.value, { strict: true }).errors).toHaveLength(0);
  });

  it('promotes semantic fill-element traces without leaking opaque refs', async () => {
    const store = makeFakeStore();
    const result = await promoteAgentTrace(
      [
        navigate,
        {
          kind: 'fill_element',
          host: 'shop.example',
          field: { role: 'combobox', name: 'Cabin', group: 'Flight search' },
          locator: [{ kind: 'role', role: 'combobox', name: 'Cabin' }],
          value: { kind: 'literal', value: 'Business' },
          requires_confirmation: false,
        },
      ],
      { workflowName: 'semantic-fill', store },
    );

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const fill = result.value.steps.find((step) => step.verb === 'fill_element');
    expect(fill).toMatchObject({
      verb: 'fill_element',
      field_name: 'Cabin',
      value: 'Business',
      locator: 's2_locator',
    });
    expect(JSON.stringify(result.value)).not.toMatch(/"e[0-9]+"/);
    expect(lint(result.value, { strict: true }).errors).toHaveLength(0);
  });

  it('declares and preserves a semantic secret fill reference', async () => {
    const store = makeFakeStore();
    const result = await promoteAgentTrace(
      [
        navigate,
        {
          kind: 'fill_element',
          host: 'shop.example',
          field: { role: 'textbox', name: 'Password', group: null },
          locator: [{ kind: 'role', role: 'textbox', name: 'Password' }],
          value: { kind: 'secret_ref', key: 'shop.password' },
          requires_confirmation: true,
        },
      ],
      { workflowName: 'semantic-secret-fill', store },
    );

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.secrets).toEqual(['shop.password']);
    expect(result.value.security_class).toBe('authenticated');
    const fill = result.value.steps.find((step) => step.verb === 'fill_element');
    expect(fill?.requires_confirmation).toBe(true);
    if (fill?.verb === 'fill_element') {
      expect(fill.value).toBe('{{ secret:shop.password }}');
    }
  });

  it('preserves mixed navigate, semantic fill, click, and extract ordering', async () => {
    const store = makeFakeStore();
    const result = await promoteAgentTrace(
      [
        navigate,
        {
          kind: 'fill_element',
          host: 'shop.example',
          field: { role: 'textbox', name: 'Destination', group: null },
          locator: [{ kind: 'role', role: 'textbox', name: 'Destination' }],
          value: { kind: 'literal', value: 'Frisco, Texas' },
          requires_confirmation: false,
        },
        {
          kind: 'click',
          host: 'shop.example',
          locator: [{ kind: 'role', role: 'button', name: 'Search' }],
          requires_confirmation: false,
        },
        {
          kind: 'extract',
          host: 'shop.example',
          extractionKind: 'content',
          requires_confirmation: false,
        },
      ],
      { workflowName: 'mixed-semantic-fill', store },
    );

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.steps.map((step) => step.verb)).toEqual([
      'navigate',
      'fill_element',
      'click',
      'extract',
    ]);
    expect(lint(result.value, { strict: true }).errors).toHaveLength(0);
  });

  it('preserves requires_confirmation flags through promotion', async () => {
    const store = makeFakeStore();
    const steps: PromotableTraceStep[] = [
      navigate,
      {
        kind: 'click',
        host: 'shop.example',
        locator: [{ kind: 'role', role: 'button', name: 'Place order' }],
        requires_confirmation: true,
      },
    ];

    const result = await promoteAgentTrace(steps, { workflowName: 'checkout', store });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const click = result.value.steps.find((s) => s.verb === 'click');
    expect(click?.requires_confirmation).toBe(true);
  });

  it('returns a typed error (never throws) for an empty trace', async () => {
    const store = makeFakeStore();
    const result = await promoteAgentTrace([], { workflowName: 'empty', store });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.error.kind).toBe('no_completed_steps');
    expect(store.saved).toHaveLength(0);
  });

  it('reports a name collision as a typed error without saving', async () => {
    const store = makeFakeStore({ existingNames: new Set(['taken']) });
    const result = await promoteAgentTrace([navigate], { workflowName: 'taken', store });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.error.kind).toBe('name_collision');
  });
});

const click = (name: string): PromotableTraceStep => ({
  kind: 'click',
  host: 'shop.example',
  locator: [{ kind: 'role', role: 'button', name }],
  requires_confirmation: false,
});

const observe: PromotableTraceStep = {
  kind: 'observe',
  host: 'shop.example',
  requires_confirmation: false,
};

/** Promotes and returns the saved workflow, failing the test on a promote error. */
async function promoted(
  steps: PromotableTraceStep[],
  extra: { readonly synthesisGoal?: string; readonly synthesisUsedLlm?: boolean } = {},
): Promise<WorkflowFile> {
  const store = makeFakeStore();
  const result = await promoteAgentTrace(steps, {
    workflowName: 'terminal-read',
    store,
    ...extra,
  });
  expect(result.isOk).toBe(true);
  if (!result.isOk) throw new Error(result.error.message);
  return result.value;
}

describe('@no-llm promoteAgentTrace terminal read', () => {
  it('promotes a trailing observe into a terminal extract step', async () => {
    // The reported gap: an agentic run routinely *ends* by observing — the
    // digest already answers the question, so `browser_extract` is never
    // called. Only extracts became steps, so the workflow clicked through and
    // captured nothing, and `yantra run` had nothing to report.
    const workflow = await promoted([navigate, click('Track'), observe]);

    expect(workflow.steps.map((s) => s.verb)).toEqual(['navigate', 'click', 'extract']);
    const extract = workflow.steps.at(-1);
    expect(extract?.verb).toBe('extract');
    if (extract?.verb !== 'extract') return;
    expect(extract.extraction_schema).toEqual({ type: 'primitive', kind: 'readable' });
  });

  it('drops observations taken mid-run, which are navigation aids not data', async () => {
    // The agent observes after every action to decide the next one. Turning
    // each into a step would bloat the workflow with reads nobody asked for.
    const workflow = await promoted([
      navigate,
      observe,
      click('Track'),
      observe,
      click('Show details'),
      observe,
    ]);

    expect(workflow.steps.map((s) => s.verb)).toEqual(['navigate', 'click', 'click', 'extract']);
  });

  it('collapses a run of trailing reads into exactly one extract', async () => {
    const workflow = await promoted([navigate, click('Track'), observe, observe, observe]);

    expect(workflow.steps.filter((s) => s.verb === 'extract')).toHaveLength(1);
  });

  it('prefers a real extract over an observation among trailing reads', async () => {
    // `browser_extract` carries the model's declared intent — it asked for a
    // table, not the page text — so it outranks an incidental observation.
    const workflow = await promoted([
      navigate,
      click('Track'),
      observe,
      {
        kind: 'extract',
        host: 'shop.example',
        extractionKind: 'table',
        requires_confirmation: false,
      },
      observe,
    ]);

    const extract = workflow.steps.at(-1);
    expect(extract?.verb).toBe('extract');
    if (extract?.verb !== 'extract') return;
    expect(extract.extraction_schema).toEqual({
      type: 'array',
      items: { type: 'primitive', kind: 'string' },
    });
  });

  it('leaves a trace with no trailing read unchanged', async () => {
    const workflow = await promoted([navigate, click('Track')]);

    expect(workflow.steps.map((s) => s.verb)).toEqual(['navigate', 'click']);
    expect(workflow.outputs).toEqual([]);
  });

  it('promotes an observe-only trace rather than discarding it', async () => {
    const workflow = await promoted([navigate, observe]);

    expect(workflow.steps.map((s) => s.verb)).toEqual(['navigate', 'extract']);
  });

  it('declares an output that unwraps the extraction envelope', async () => {
    // Captures hold an `ExtractionResultEnvelope` ({rows, metadata}); binding
    // the raw capture would surface that wrapper instead of the value.
    const workflow = await promoted([navigate, click('Track'), observe]);

    expect(workflow.outputs).toEqual([
      { name: 'extracted_content_1', from: '{{ capture.extracted_content_1.rows[0] }}' },
    ]);
  });

  it('binds a table output to the whole rows array', async () => {
    const workflow = await promoted([
      navigate,
      {
        kind: 'extract',
        host: 'shop.example',
        extractionKind: 'table',
        requires_confirmation: false,
      },
    ]);

    expect(workflow.outputs).toEqual([
      { name: 'extracted_table_1', from: '{{ capture.extracted_table_1.rows }}' },
    ]);
  });

  it('keeps the promoted workflow schema-valid and lint-clean', async () => {
    const workflow = await promoted([navigate, click('Track'), observe]);

    expect(() => WorkflowFileSchema.parse(workflow)).not.toThrow();
    expect(lint(workflow, { strict: true }).errors).toEqual([]);
  });
});

describe('@no-llm promoteAgentTrace synthesis block', () => {
  const extractTrace: PromotableTraceStep[] = [
    navigate,
    {
      kind: 'extract',
      host: 'shop.example',
      extractionKind: 'content',
      requires_confirmation: false,
    },
  ];

  it('carries the run goal into synthesis.goal with medium/standard defaults', async () => {
    const workflow = await promoted(extractTrace, {
      synthesisGoal: 'When will my package arrive?',
    });

    expect(workflow.synthesis).toEqual({
      goal: 'When will my package arrive?',
      length: 'medium',
      detail: 'standard',
      use_llm: false,
    });
  });

  it('keeps a workflow promoted with a goal schema-valid and lint-clean', async () => {
    // Load-bearing: promotion lints strictly, which promotes warnings to
    // errors. A synthesis block paired with a terminal extract must stay clean,
    // or `do --save-as` would start failing to promote.
    const workflow = await promoted(extractTrace, { synthesisGoal: 'the goal' });

    expect(() => WorkflowFileSchema.parse(workflow)).not.toThrow();
    expect(lint(workflow, { strict: true }).errors).toEqual([]);
  });

  it('leaves synthesis null when no goal is supplied (existing behavior)', async () => {
    const workflow = await promoted(extractTrace);

    expect(workflow.synthesis).toBeNull();
  });

  it('leaves synthesis null for a blank or whitespace-only goal', async () => {
    expect((await promoted(extractTrace, { synthesisGoal: '' })).synthesis).toBeNull();
    expect((await promoted(extractTrace, { synthesisGoal: '   ' })).synthesis).toBeNull();
  });

  it('trims the goal it carries', async () => {
    const workflow = await promoted(extractTrace, { synthesisGoal: '  padded goal  ' });

    expect(workflow.synthesis?.goal).toBe('padded goal');
  });

  it('truncates an over-long goal rather than failing promotion', async () => {
    // Promotion is best-effort and must never fail a published run, so a goal
    // beyond the schema's 512-char cap is clipped, not rejected.
    const workflow = await promoted(extractTrace, { synthesisGoal: 'g'.repeat(900) });

    expect(workflow.synthesis?.goal).toHaveLength(512);
    expect(() => WorkflowFileSchema.parse(workflow)).not.toThrow();
  });

  it('records use_llm when the promoted run had a model write its report', async () => {
    // This is what removes the mode flag from `yantra run`: the saved workflow
    // remembers how its document was authored, so replaying it reproduces the
    // document rather than a plainer imitation.
    const workflow = await promoted(extractTrace, {
      synthesisGoal: 'the goal',
      synthesisUsedLlm: true,
    });

    expect(workflow.synthesis?.use_llm).toBe(true);
  });

  it('keeps a workflow promoted with use_llm schema-valid and lint-clean', async () => {
    const workflow = await promoted(extractTrace, {
      synthesisGoal: 'the goal',
      synthesisUsedLlm: true,
    });

    expect(() => WorkflowFileSchema.parse(workflow)).not.toThrow();
    expect(lint(workflow, { strict: true }).errors).toEqual([]);
  });

  it('leaves use_llm false when the promoted run wrote its report deterministically', async () => {
    const workflow = await promoted(extractTrace, {
      synthesisGoal: 'the goal',
      synthesisUsedLlm: false,
    });

    expect(workflow.synthesis?.use_llm).toBe(false);
  });

  it('declares no synthesis at all when only model provenance is supplied', async () => {
    // `synthesisUsedLlm` describes a document; with no goal there is no document
    // to describe, and promising one the workflow cannot produce would be worse
    // than promising nothing.
    const workflow = await promoted(extractTrace, { synthesisUsedLlm: true });

    expect(workflow.synthesis).toBeNull();
  });
});
