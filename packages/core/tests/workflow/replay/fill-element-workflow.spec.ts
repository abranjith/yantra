// @no-llm
import {
  WorkflowFile,
  validateWorkflowSemantics,
  type WorkflowFile as WorkflowFileType,
} from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { lint } from '../../../src/workflow/lint/index.js';
import { translate } from '../../../src/workflow/replay/workflow-to-plan.js';
import { emitWorkflow } from '../../../src/workflow/yaml/emitter.js';
import { parseWorkflowYaml } from '../../../src/workflow/yaml/parser.js';

function workflow(value: string): WorkflowFileType {
  return WorkflowFile.parse({
    version: 1,
    name: 'fill-element-fixture',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {
      from: { type: 'date', required: true, example: '2026-08-21' },
      to: { type: 'date', required: true, example: '2026-08-22' },
    },
    secrets: [],
    cookies: 'none',
    steps: [
      {
        id: 's1',
        verb: 'fill_element',
        field_name: 'Dates',
        locator: 'Dates field',
        value,
        scope: null,
        requires_confirmation: false,
      },
    ],
    outputs: [],
    synthesis: null,
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {
      'Dates field': [{ kind: 'role', role: 'button', name: 'Dates' }],
    },
  });
}

describe('@no-llm fill_element workflow schema and translation', () => {
  it('round-trips canonical YAML and keeps the locator lint-clean', () => {
    const original = workflow('{{ param:from }}..{{ param:to }}');
    const parsed = parseWorkflowYaml(emitWorkflow(original).yaml);

    expect(parsed.isOk).toBe(true);
    if (!parsed.isOk) return;
    expect(parsed.value.steps[0]).toMatchObject({
      verb: 'fill_element',
      field_name: 'Dates',
      locator: 'Dates field',
    });
    expect(lint(parsed.value, { strict: true }).errors).toHaveLength(0);
  });

  it('compiles embedded range params to a typed TemplateRef', () => {
    const translated = translate(workflow('{{ param:from }}..{{ param:to }}'), {
      from: '2026-08-21',
      to: '2026-08-22',
    });
    const step = translated.plan.steps[0];

    expect(step).toMatchObject({
      type: 'fill_element',
      field_name: 'Dates',
      locator: { kind: 'workflow', name: 'Dates field' },
      value: {
        kind: 'template',
        template: '{{value_0}}..{{value_1}}',
        bindings: {
          value_0: { kind: 'param', key: 'from' },
          value_1: { kind: 'param', key: 'to' },
        },
      },
    });
  });

  it('lints undeclared refs and unknown locators on the new verb', () => {
    const invalid = {
      ...workflow('{{ param:from }}'),
      params: {},
      steps: [
        {
          ...workflow('{{ param:from }}').steps[0]!,
          locator: 'Missing locator',
        },
      ],
    } as WorkflowFileType;

    const report = lint(invalid, { strict: true });
    expect(report.errors.map((finding) => finding.code)).toContain('UndeclaredParamRef');
    const semantic = validateWorkflowSemantics(invalid);
    expect(semantic.result.isOk).toBe(false);
    if (!semantic.result.isOk) {
      expect(semantic.result.error.map((finding) => finding.code)).toContain(
        'unknown_workflow_locator',
      );
    }
  });

  it('rejects a credential-shaped literal on the semantic fill verb', () => {
    const report = lint(workflow(`sk-${'a'.repeat(24)}`), { strict: true });

    expect(report.errors.map((finding) => finding.code)).toContain('SecretShapedLiteralInValue');
  });

  it('accepts confirmation on fill_element while the schema still rejects it on extract', () => {
    const confirmable = {
      ...workflow('Business'),
      steps: [{ ...workflow('Business').steps[0]!, requires_confirmation: true }],
    };
    expect(WorkflowFile.safeParse(confirmable).success).toBe(true);

    const invalidExtract = {
      ...workflow('Business'),
      steps: [
        {
          id: 's1',
          verb: 'extract',
          locator: 'Dates field',
          extraction_schema: { type: 'primitive', kind: 'string' },
          capture_as: 'result',
          scope: null,
          requires_confirmation: true,
        },
      ],
    };
    expect(WorkflowFile.safeParse(invalidExtract).success).toBe(false);
  });
});
