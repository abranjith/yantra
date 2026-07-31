// @no-llm
import type { WorkflowFile } from '@yantra/protocol';
import { describe, it, expect } from 'vitest';

import { emitWorkflow } from '../../../src/workflow/yaml/emitter.js';
import { parseWorkflowYaml } from '../../../src/workflow/yaml/parser.js';

function makeMinimalWorkflow(overrides: Partial<WorkflowFile> = {}): WorkflowFile {
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
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {},
    ...overrides,
  };
}

describe('emitWorkflow', () => {
  it('emits a yaml-language-server schema comment as first line', () => {
    const workflow = makeMinimalWorkflow();
    const { yaml } = emitWorkflow(workflow);
    expect(yaml.startsWith('# yaml-language-server: $schema=')).toBe(true);
  });

  it('uses the custom schemaHref when provided', () => {
    const workflow = makeMinimalWorkflow();
    const { yaml } = emitWorkflow(workflow, {
      schemaHref: 'https://example.com/schema.json',
    });
    expect(yaml).toContain('https://example.com/schema.json');
  });

  it('emits keys in stable order: version, name, description, security_class before steps', () => {
    const workflow = makeMinimalWorkflow({ description: 'A test workflow' });
    const { yaml } = emitWorkflow(workflow);

    const versionIdx = yaml.indexOf('version:');
    const nameIdx = yaml.indexOf('name:');
    const descIdx = yaml.indexOf('description:');
    const secIdx = yaml.indexOf('security_class:');
    const stepsIdx = yaml.indexOf('steps:');

    expect(versionIdx).toBeLessThan(nameIdx);
    expect(nameIdx).toBeLessThan(descIdx);
    expect(descIdx).toBeLessThan(secIdx);
    expect(secIdx).toBeLessThan(stepsIdx);
  });

  it('omits outputs_unredacted when false (default)', () => {
    const workflow = makeMinimalWorkflow({ outputs_unredacted: false });
    const { yaml } = emitWorkflow(workflow);
    expect(yaml).not.toContain('outputs_unredacted');
  });

  it('includes outputs_unredacted when true', () => {
    const workflow = makeMinimalWorkflow({ outputs_unredacted: true });
    const { yaml } = emitWorkflow(workflow);
    expect(yaml).toContain('outputs_unredacted');
  });

  it('omits recorded_with when null', () => {
    const workflow = makeMinimalWorkflow({ recorded_with: null });
    const { yaml } = emitWorkflow(workflow);
    expect(yaml).not.toContain('recorded_with');
  });

  it('includes recorded_with when set', () => {
    const workflow = makeMinimalWorkflow({
      recorded_with: { chrome_major: 124, yantra_version: '0.1.0' },
    });
    const { yaml } = emitWorkflow(workflow);
    expect(yaml).toContain('recorded_with');
    expect(yaml).toContain('chrome_major');
  });

  it('emits shorthand navigate step when scope is null', () => {
    const workflow = makeMinimalWorkflow();
    const { yaml } = emitWorkflow(workflow);
    // Should have shorthand form: navigate: https://example.com
    expect(yaml).toContain('navigate:');
  });

  it('emits canonical form when step has non-default properties', () => {
    const workflow = makeMinimalWorkflow({
      steps: [
        {
          id: 's1',
          verb: 'wait_for',
          locator: 'Some element',
          state: 'hidden',
          timeout_ms: 5000,
          scope: null,
        },
      ],
      _locators: {
        'Some element': [{ kind: 'label', value: 'Some element' }],
      },
    });
    const { yaml } = emitWorkflow(workflow);
    expect(yaml).toContain('verb: wait_for');
    expect(yaml).toContain('state: hidden');
  });

  it('returns sidecarJson when _locators count exceeds threshold', () => {
    const locators: Record<string, [{ kind: 'label'; value: string }]> = {};
    for (let i = 0; i < 51; i++) {
      locators[`Locator ${i}`] = [{ kind: 'label', value: `Element ${i}` }];
    }

    const workflow = makeMinimalWorkflow({ _locators: locators });
    const { yaml, sidecarJson } = emitWorkflow(workflow, { sidecarThreshold: 50 });

    expect(sidecarJson).not.toBeNull();
    expect(yaml).toContain('_locators_ref');
    if (sidecarJson !== null) {
      const parsed = JSON.parse(sidecarJson) as unknown;
      expect(typeof parsed).toBe('object');
    }
  });

  it('does not return sidecarJson when _locators count is at or below threshold', () => {
    const locators: Record<string, [{ kind: 'label'; value: string }]> = {};
    for (let i = 0; i < 10; i++) {
      locators[`Locator ${i}`] = [{ kind: 'label', value: `Element ${i}` }];
    }

    const workflow = makeMinimalWorkflow({ _locators: locators });
    const { sidecarJson } = emitWorkflow(workflow, { sidecarThreshold: 50 });

    expect(sidecarJson).toBeNull();
  });

  it('produced YAML can be re-parsed by the parser', () => {
    const workflow = makeMinimalWorkflow({
      description: 'A round-trip test',
      params: {
        month: { type: 'string', example: '2026-04', required: true },
      },
      secrets: ['bank.password'],
    });

    const { yaml } = emitWorkflow(workflow);
    const reparsed = parseWorkflowYaml(yaml);
    expect(reparsed.isOk).toBe(true);
    if (reparsed.isOk) {
      expect(reparsed.value.name).toBe(workflow.name);
    }
  });

  describe('the synthesis block', () => {
    const synthesis = {
      goal: 'When will my package arrive?',
      length: 'medium',
      detail: 'standard',
      use_llm: true,
    } as const;

    it('omits synthesis when the workflow declares none', () => {
      const { yaml } = emitWorkflow(makeMinimalWorkflow({ synthesis: null }));

      expect(yaml).not.toContain('synthesis:');
    });

    it('emits the declared synthesis block', () => {
      // Without this the block was built in memory, passed lint, and then
      // vanished at save time — a promoted workflow reloaded as
      // `synthesis: null` and replayed as a raw capture dump.
      const { yaml } = emitWorkflow(makeMinimalWorkflow({ synthesis }));

      expect(yaml).toContain('synthesis:');
      expect(yaml).toContain('goal: When will my package arrive?');
    });

    it('emits use_llm so the saved workflow remembers how its Brief is written', () => {
      const { yaml } = emitWorkflow(makeMinimalWorkflow({ synthesis }));

      expect(yaml).toContain('use_llm: true');
    });

    it('survives an emit → parse round trip intact', () => {
      const { yaml } = emitWorkflow(makeMinimalWorkflow({ synthesis }));
      const reparsed = parseWorkflowYaml(yaml);

      expect(reparsed.isOk).toBe(true);
      if (reparsed.isOk) {
        expect(reparsed.value.synthesis).toEqual(synthesis);
      }
    });

    it('round-trips a deterministic block without acquiring use_llm', () => {
      const { yaml } = emitWorkflow(
        makeMinimalWorkflow({ synthesis: { ...synthesis, use_llm: false } }),
      );
      const reparsed = parseWorkflowYaml(yaml);

      expect(reparsed.isOk && reparsed.value.synthesis?.use_llm).toBe(false);
    });

    it('places synthesis after steps and outputs in the emitted key order', () => {
      const { yaml } = emitWorkflow(
        makeMinimalWorkflow({
          synthesis,
          outputs: [{ name: 'captured', from: '{{ capture.x.rows[0] }}' }],
          outputs_unredacted: true,
        }),
      );

      expect(yaml.indexOf('steps:')).toBeLessThan(yaml.indexOf('outputs:'));
      expect(yaml.indexOf('outputs:')).toBeLessThan(yaml.indexOf('synthesis:'));
      expect(yaml.indexOf('synthesis:')).toBeLessThan(yaml.indexOf('outputs_unredacted:'));
    });
  });
});
