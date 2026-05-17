// @no-llm
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { emitWorkflow } from '../../../src/workflow/yaml/emitter.js';
import { loadWorkflow, parseWorkflowYaml } from '../../../src/workflow/yaml/parser.js';

const FIXTURES_DIR = join(import.meta.dirname, '../../fixtures/workflows');

describe('parseWorkflowYaml', () => {
  it('returns ok for a valid workflow YAML string', () => {
    const yaml = `
version: 1
name: test-wf
description: null
security_class: public
steps:
  - id: s1
    verb: navigate
    url: https://example.com
    scope: null
`.trim();

    const result = parseWorkflowYaml(yaml);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('test-wf');
      expect(result.value.steps).toHaveLength(1);
    }
  });

  it('returns err with YamlSyntax for malformed YAML', () => {
    const badYaml = `
version: 1
name: [invalid
  - broken
`.trim();

    const result = parseWorkflowYaml(badYaml);
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error.errors).toHaveLength(1);
      expect(result.error.errors[0]?.code).toBe('YamlSyntax');
      expect(result.error.errors[0]?.severity).toBe('error');
    }
  });

  it('returns err with SchemaInvalid for YAML that fails Zod validation', () => {
    const invalidYaml = `
version: 1
name: "INVALID NAME WITH SPACES"
security_class: public
steps:
  - id: s1
    verb: navigate
    url: https://example.com
    scope: null
`.trim();

    const result = parseWorkflowYaml(invalidYaml);
    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error.errors.length).toBeGreaterThan(0);
      expect(result.error.errors[0]?.code).toBe('SchemaInvalid');
    }
  });

  it('parses shorthand navigate step', () => {
    const yaml = `
version: 1
name: short-wf
description: null
security_class: public
steps:
  - navigate: https://example.com
`.trim();

    const result = parseWorkflowYaml(yaml);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      const step = result.value.steps[0];
      expect(step?.verb).toBe('navigate');
      if (step?.verb === 'navigate') {
        expect(step.url).toBe('https://example.com');
      }
    }
  });

  it('parses shorthand click step', () => {
    const yaml = `
version: 1
name: click-wf
description: null
security_class: public
steps:
  - navigate: https://example.com
  - click: Submit button
_locators:
  Submit button:
    - kind: role
      role: button
      name: Submit
`.trim();

    const result = parseWorkflowYaml(yaml);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      const step = result.value.steps[1];
      expect(step?.verb).toBe('click');
      if (step?.verb === 'click') {
        expect(step.locator).toBe('Submit button');
      }
    }
  });
});

describe('loadWorkflow', () => {
  it('loads the bank-statement fixture and returns ok', async () => {
    const result = await loadWorkflow(join(FIXTURES_DIR, 'bank-statement.yaml'));
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('bank-statement');
      expect(result.value.security_class).toBe('authenticated');
      expect(result.value.steps).toHaveLength(6);
      expect(result.value.secrets).toContain('bank.username');
    }
  });

  it('throws on filesystem errors (file not found)', async () => {
    await expect(loadWorkflow('/nonexistent/path/workflow.yaml')).rejects.toThrow();
  });

  it('round-trips emit→parse to produce equivalent workflow', async () => {
    const loadResult = await loadWorkflow(join(FIXTURES_DIR, 'bank-statement.yaml'));
    expect(loadResult.isOk).toBe(true);
    if (!loadResult.isOk) return;

    const workflow = loadResult.value;
    const { yaml } = emitWorkflow(workflow);
    const reparsed = parseWorkflowYaml(yaml);

    expect(reparsed.isOk).toBe(true);
    if (reparsed.isOk) {
      expect(reparsed.value.name).toBe(workflow.name);
      expect(reparsed.value.steps.length).toBe(workflow.steps.length);
      expect(reparsed.value.secrets).toEqual(workflow.secrets);
    }
  });
});
