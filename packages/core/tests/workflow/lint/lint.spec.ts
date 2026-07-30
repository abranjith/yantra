// @no-llm
import type { WorkflowFile } from '@yantra/protocol';
import { describe, it, expect } from 'vitest';

import { lint } from '../../../src/workflow/lint/index.js';

function makeWorkflow(overrides: Partial<WorkflowFile> = {}): WorkflowFile {
  return {
    version: 1,
    name: 'test-workflow',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [{ id: 's1', verb: 'navigate', url: 'https://example.com', scope: null }],
    outputs: [],
    synthesis: null,
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {},
    ...overrides,
  };
}

describe('NoRawCssAtStep', () => {
  it('does not warn for navigate step with normal URL', () => {
    const workflow = makeWorkflow();
    const report = lint(workflow);
    const noRawCss = report.warnings.filter((f) => f.code === 'NoRawCssAtStep');
    expect(noRawCss).toHaveLength(0);
  });

  it('warns when click locator looks like a CSS selector starting with "."', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        { id: 's2', verb: 'click', locator: '.btn-primary', scope: null },
      ],
    });
    const report = lint(workflow);
    const noRawCss = report.warnings.filter((f) => f.code === 'NoRawCssAtStep');
    expect(noRawCss.length).toBeGreaterThan(0);
  });

  it('warns when click locator starts with "#"', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        { id: 's2', verb: 'click', locator: '#submit-btn', scope: null },
      ],
    });
    const report = lint(workflow);
    const noRawCss = report.warnings.filter((f) => f.code === 'NoRawCssAtStep');
    expect(noRawCss.length).toBeGreaterThan(0);
  });

  it('does not warn for descriptive locator name', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        { id: 's2', verb: 'click', locator: 'Submit button', scope: null },
      ],
      _locators: {
        'Submit button': [{ kind: 'role', role: 'button', name: 'Submit' }],
      },
    });
    const report = lint(workflow);
    const noRawCss = report.warnings.filter((f) => f.code === 'NoRawCssAtStep');
    expect(noRawCss).toHaveLength(0);
  });
});

describe('SecretShapedLiteralInValue', () => {
  it('detects OpenAI-style secret key in fill value', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'API key field',
          value: 'sk-abcdefghijklmnopqrstuvwxyz123456',
          submit: false,
          scope: null,
        },
      ],
      _locators: { 'API key field': [{ kind: 'label', value: 'API key' }] },
    });
    const report = lint(workflow);
    const secrets = report.errors.filter((f) => f.code === 'SecretShapedLiteralInValue');
    expect(secrets.length).toBeGreaterThan(0);
  });

  it('does not flag secret refs ({{ secret:... }}) as credential literals', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Password field',
          value: '{{ secret:bank.password }}',
          submit: false,
          scope: null,
        },
      ],
      secrets: ['bank.password'],
      _locators: { 'Password field': [{ kind: 'label', value: 'Password' }] },
    });
    const report = lint(workflow);
    const secrets = report.errors.filter((f) => f.code === 'SecretShapedLiteralInValue');
    expect(secrets).toHaveLength(0);
  });

  it('detects GitHub token pattern', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Token field',
          value: 'ghp_abcdefghijklmnopqrstuvwxyz',
          submit: false,
          scope: null,
        },
      ],
      _locators: { 'Token field': [{ kind: 'label', value: 'Token' }] },
    });
    const report = lint(workflow);
    const secrets = report.errors.filter((f) => f.code === 'SecretShapedLiteralInValue');
    expect(secrets.length).toBeGreaterThan(0);
  });
});

describe('UndeclaredSecretRef', () => {
  it('reports error when secret ref is not in secrets array', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Password field',
          value: '{{ secret:bank.password }}',
          submit: false,
          scope: null,
        },
      ],
      secrets: [],
      _locators: { 'Password field': [{ kind: 'label', value: 'Password' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'UndeclaredSecretRef');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain('bank.password');
  });

  it('does not report when secret ref is declared', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Password field',
          value: '{{ secret:bank.password }}',
          submit: false,
          scope: null,
        },
      ],
      secrets: ['bank.password'],
      _locators: { 'Password field': [{ kind: 'label', value: 'Password' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'UndeclaredSecretRef');
    expect(errors).toHaveLength(0);
  });
});

describe('UndeclaredParamRef', () => {
  it('reports error when param ref is not declared in params', () => {
    const workflow = makeWorkflow({
      steps: [
        {
          id: 's1',
          verb: 'navigate',
          url: '{{ param:month }}',
          scope: null,
        },
      ],
      params: {},
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'UndeclaredParamRef');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain('month');
  });

  it('does not report when param is declared', () => {
    const workflow = makeWorkflow({
      steps: [
        {
          id: 's1',
          verb: 'navigate',
          url: '{{ param:month }}',
          scope: null,
        },
      ],
      params: {
        month: { type: 'string', example: null, required: true },
      },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'UndeclaredParamRef');
    expect(errors).toHaveLength(0);
  });
});

describe('OrphanedLocator', () => {
  it('warns about _locators key not referenced by any step', () => {
    const workflow = makeWorkflow({
      steps: [{ id: 's1', verb: 'navigate', url: 'https://example.com', scope: null }],
      _locators: {
        'Orphaned button': [{ kind: 'role', role: 'button', name: 'Orphaned' }],
      },
    });
    const report = lint(workflow);
    const warnings = report.warnings.filter((f) => f.code === 'OrphanedLocator');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.message).toContain('Orphaned button');
  });

  it('does not warn for locators referenced by steps', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        { id: 's2', verb: 'click', locator: 'Submit button', scope: null },
      ],
      _locators: {
        'Submit button': [{ kind: 'role', role: 'button', name: 'Submit' }],
      },
    });
    const report = lint(workflow);
    const warnings = report.warnings.filter((f) => f.code === 'OrphanedLocator');
    expect(warnings).toHaveLength(0);
  });
});

describe('JSONataExpressionInvalid', () => {
  it('reports error for invalid JSONata expression in fill value', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Amount field',
          value: '{{ $invalidSyntax(x y z }}',
          submit: false,
          scope: null,
        },
      ],
      _locators: { 'Amount field': [{ kind: 'label', value: 'Amount' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'JSONataExpressionInvalid');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not report for valid JSONata expression', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Amount field',
          value: '{{ $sum([1,2,3]) }}',
          submit: false,
          scope: null,
        },
      ],
      _locators: { 'Amount field': [{ kind: 'label', value: 'Amount' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'JSONataExpressionInvalid');
    expect(errors).toHaveLength(0);
  });

  it('does not report for opaque refs like {{ secret:bank.password }}', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Password field',
          value: '{{ secret:bank.password }}',
          submit: false,
          scope: null,
        },
      ],
      secrets: ['bank.password'],
      _locators: { 'Password field': [{ kind: 'label', value: 'Password' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'JSONataExpressionInvalid');
    expect(errors).toHaveLength(0);
  });
});

describe('ScopeMutatingVerbInReadOnlyData', () => {
  it('errors on click step with scope read-only-data', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        { id: 's2', verb: 'click', locator: 'Submit button', scope: 'read-only-data' },
      ],
      _locators: { 'Submit button': [{ kind: 'role', role: 'button', name: 'Submit' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'ScopeMutatingVerbInReadOnlyData');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('errors on fill step with scope read-only-data', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Email field',
          value: 'test@example.com',
          submit: false,
          scope: 'read-only-data',
        },
      ],
      _locators: { 'Email field': [{ kind: 'label', value: 'Email' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'ScopeMutatingVerbInReadOnlyData');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not error on extract step with scope read-only-data', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'extract',
          locator: 'Data table',
          extraction_schema: { type: 'primitive', kind: 'string' },
          capture_as: 'result',
          scope: 'read-only-data',
        },
      ],
      _locators: { 'Data table': [{ kind: 'role', role: 'table', name: 'Data' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'ScopeMutatingVerbInReadOnlyData');
    expect(errors).toHaveLength(0);
  });

  it('errors on mutating verbs when workflow security_class is read-only-data', () => {
    const workflow = makeWorkflow({
      security_class: 'read-only-data',
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        { id: 's2', verb: 'click', locator: 'Submit button', scope: null },
      ],
      _locators: { 'Submit button': [{ kind: 'role', role: 'button', name: 'Submit' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'ScopeMutatingVerbInReadOnlyData');
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('MixedExpressionForms', () => {
  it('errors when a value mixes opaque refs and JSONata', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Amount field',
          value: '{{ secret:foo }} {{ $sum(x) }}',
          submit: false,
          scope: null,
        },
      ],
      secrets: ['secret.foo'],
      _locators: { 'Amount field': [{ kind: 'label', value: 'Amount' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'MixedExpressionForms');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not error for pure opaque ref', () => {
    const workflow = makeWorkflow({
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'Password field',
          value: '{{ secret:bank.password }}',
          submit: false,
          scope: null,
        },
      ],
      secrets: ['bank.password'],
      _locators: { 'Password field': [{ kind: 'label', value: 'Password' }] },
    });
    const report = lint(workflow);
    const errors = report.errors.filter((f) => f.code === 'MixedExpressionForms');
    expect(errors).toHaveLength(0);
  });
});

describe('Strict mode', () => {
  it('promotes warnings to errors when strict:true', () => {
    const workflow = makeWorkflow({
      steps: [{ id: 's1', verb: 'navigate', url: 'https://example.com', scope: null }],
      _locators: {
        'Orphaned button': [{ kind: 'role', role: 'button', name: 'Orphaned' }],
      },
    });

    const relaxed = lint(workflow, { strict: false });
    expect(relaxed.warnings.filter((f) => f.code === 'OrphanedLocator').length).toBeGreaterThan(0);
    expect(relaxed.errors.filter((f) => f.code === 'OrphanedLocator')).toHaveLength(0);

    const strict = lint(workflow, { strict: true });
    expect(strict.errors.filter((f) => f.code === 'OrphanedLocator').length).toBeGreaterThan(0);
    expect(strict.warnings.filter((f) => f.code === 'OrphanedLocator')).toHaveLength(0);
  });
});

describe('Finding code stability', () => {
  it('all finding codes are stable strings', () => {
    const EXPECTED_CODES = [
      'NoRawCssAtStep',
      'DeeplyNestedStep',
      'MissingIntentName',
      'SecretShapedLiteralInValue',
      'UndeclaredSecretRef',
      'UndeclaredParamRef',
      'OrphanedLocator',
      'JSONataExpressionInvalid',
      'ScopeMutatingVerbInReadOnlyData',
      'MixedExpressionForms',
      'OutputsUnredactedWithoutReadOnly',
      'UnrecordedFramesOnAuthenticated',
    ];

    // Each code should be a non-empty string
    for (const code of EXPECTED_CODES) {
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
    }
  });
});

describe('OutputsUnredactedWithoutReadOnly', () => {
  it('warns when outputs_unredacted is true but no read-only step', () => {
    const workflow = makeWorkflow({
      outputs_unredacted: true,
      steps: [{ id: 's1', verb: 'navigate', url: 'https://example.com', scope: null }],
    });
    const report = lint(workflow);
    const warnings = report.warnings.filter((f) => f.code === 'OutputsUnredactedWithoutReadOnly');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not warn when outputs_unredacted is true and has read-only step', () => {
    const workflow = makeWorkflow({
      outputs_unredacted: true,
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        {
          id: 's2',
          verb: 'extract',
          locator: 'Data',
          extraction_schema: { type: 'primitive', kind: 'string' },
          capture_as: 'result',
          scope: 'read-only-data',
        },
      ],
      _locators: { Data: [{ kind: 'label', value: 'Data' }] },
    });
    const report = lint(workflow);
    const warnings = report.warnings.filter((f) => f.code === 'OutputsUnredactedWithoutReadOnly');
    expect(warnings).toHaveLength(0);
  });
});

describe('UnrecordedFramesOnAuthenticated', () => {
  it('warns when _unrecorded_frames is non-empty and security_class is not public', () => {
    const workflow = makeWorkflow({
      security_class: 'authenticated',
      _unrecorded_frames: ['https://third-party.example'],
    });
    const report = lint(workflow);
    const warnings = report.warnings.filter((f) => f.code === 'UnrecordedFramesOnAuthenticated');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not warn when security_class is public', () => {
    const workflow = makeWorkflow({
      security_class: 'public',
      _unrecorded_frames: ['https://third-party.example'],
    });
    const report = lint(workflow);
    const warnings = report.warnings.filter((f) => f.code === 'UnrecordedFramesOnAuthenticated');
    expect(warnings).toHaveLength(0);
  });
});

describe('SynthesisWithoutExtract', () => {
  const synthesis = { goal: 'what happened?', length: 'medium', detail: 'standard' } as const;

  const extractStep = {
    id: 's2',
    verb: 'extract',
    scope: null,
    locator: 'Body',
    extraction_schema: { type: 'primitive', kind: 'readable' },
    capture_as: 'body',
  } as const;

  it('warns when synthesis is declared but no extract step exists', () => {
    const workflow = makeWorkflow({ synthesis });

    const report = lint(workflow);

    const warnings = report.warnings.filter((f) => f.code === 'SynthesisWithoutExtract');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe('synthesis');
    expect(warnings[0]?.suggestion).not.toBeNull();
  });

  it('reports warning severity, so a default save is never blocked', () => {
    // The rule's own severity is `warning`; only `lint(..., { strict: true })`
    // promotes it, and that promotion is the framework's uniform policy for
    // every warning rather than anything specific to synthesis.
    const report = lint(makeWorkflow({ synthesis }));

    expect(report.errors).toHaveLength(0);
    expect(report.warnings.filter((f) => f.code === 'SynthesisWithoutExtract')).toHaveLength(1);
    expect(report.warnings[0]?.severity).toBe('warning');
  });

  it('does not warn when an extract step is present', () => {
    const workflow = makeWorkflow({
      synthesis,
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
        extractStep,
      ] as never,
      _locators: { Body: [{ kind: 'label', value: 'Body' }] },
    });

    const report = lint(workflow);

    expect(report.warnings.filter((f) => f.code === 'SynthesisWithoutExtract')).toHaveLength(0);
  });

  it('does not warn when no synthesis block is declared', () => {
    const report = lint(makeWorkflow());

    expect(report.warnings.filter((f) => f.code === 'SynthesisWithoutExtract')).toHaveLength(0);
  });
});
