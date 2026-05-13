import { describe, expect, it } from 'vitest';

import { createToolCatalog } from '../src/index.js';

const EXPECTED_TOOLS = [
  'navigate',
  'click',
  'fill',
  'extract',
  'wait_for',
  'assert',
  'branch',
  'loop',
  'call_workflow',
  'llm_summarize',
] as const;

describe('@no-llm tool catalog emitter', () => {
  it('covers every step variant', () => {
    const catalog = createToolCatalog();
    const names = catalog.map((entry) => entry.name);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('emits vendor-neutral entries', () => {
    const catalog = createToolCatalog();
    catalog.forEach((entry) => {
      expect(entry.output_schema).toBeNull();
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    });
  });
});
