// @no-llm
import type { WorkflowFile } from '@yantra/protocol';
import { WorkflowFile as WorkflowFileSchema } from '@yantra/protocol';
import { describe, it, expect, vi } from 'vitest';

import {
  promoteAgentTrace,
  type PromotableTraceStep,
} from '../../src/discovery/promote.js';
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
    expect(result.value.steps.map((s) => s.verb)).toEqual([
      'navigate',
      'fill',
      'click',
      'extract',
    ]);
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
