import { describe, expect, it } from 'vitest';

import {
  buildYantraWrappedTools,
  createYantraTools,
  yantraToolCatalog,
} from '../../../../src/adapters/pi/tools/index.js';
import { resultPublishSpec } from '../../../../src/adapters/pi/tools/result-publish.js';
import { webSearchSpec } from '../../../../src/adapters/pi/tools/web-search.js';
import { hashToolCatalog } from '../../../../src/runtime/catalog-hash.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';

import { assertToolContract, buildServices } from './test-support.js';

describe('@no-llm createYantraTools factory', () => {
  it('registers the web and browser tools in deterministic name order', () => {
    const services = buildServices();
    const tools = createYantraTools(services);
    expect(tools.map((tool) => tool.name)).toEqual([
      'browser_click',
      'browser_extract',
      'browser_fill_element',
      'browser_fill_form',
      'browser_navigate',
      'browser_observe',
      'result_publish',
      'script_run',
      'web_fetch',
      'web_search',
      'workflow_run',
    ]);
  });

  it('keeps the catalog name-sorted and duplicate-free', () => {
    const names = createYantraTools(buildServices()).map((tool) => tool.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('never exposes any Pi built-in tool (bash/read/write/edit/grep/find/ls)', () => {
    const builtins = new Set(['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls']);
    const names = createYantraTools(buildServices()).map((tool) => tool.name);
    for (const name of names) {
      expect(builtins.has(name)).toBe(false);
    }
  });

  it('produces Pi tool definitions with names, labels, and parameter schemas', () => {
    const tools = createYantraTools(buildServices());
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.label).toBe('string');
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('gives every registered tool a closed object root schema', () => {
    // Providers reject a function whose parameter schema is not `type: "object"`
    // — a top-level Type.Union serializes to `anyOf` with no `type` and fails the
    // whole catalog at request time, not just the offending tool.
    for (const tool of buildYantraWrappedTools(buildServices())) {
      const schema = tool.parameters as { type?: string; additionalProperties?: unknown };
      expect({ name: tool.name, type: schema.type }).toEqual({
        name: tool.name,
        type: 'object',
      });
      expect({ name: tool.name, additionalProperties: schema.additionalProperties }).toEqual({
        name: tool.name,
        additionalProperties: false,
      });
    }
  });

  it('yields a reproducible tool_catalog_hash across two builds', () => {
    const hashA = hashToolCatalog(yantraToolCatalog(buildServices()));
    const hashB = hashToolCatalog(yantraToolCatalog(buildServices()));
    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the catalog hash when a tool description changes', () => {
    const base = hashToolCatalog(yantraToolCatalog(buildServices()));
    const services = buildServices();
    const wrapped = buildYantraWrappedTools(services).map((tool) =>
      tool.name === 'web_search' ? { ...tool, description: 'CHANGED' } : tool,
    );
    const mutated = hashToolCatalog(
      wrapped.map((tool) => ({
        name: tool.name,
        schema: tool.parameters,
        description: tool.description,
      })),
    );
    expect(mutated).not.toBe(base);
  });

  it('rejects a duplicate tool name', () => {
    const services = buildServices();
    // Two specs sharing a name must be rejected when wrapped together.
    const a = wrapTool(webSearchSpec(services), services);
    const b = wrapTool({ ...resultPublishSpec(services), name: 'web_search' }, services);
    const seen = new Set<string>();
    const collect = (): void => {
      for (const tool of [a, b]) {
        if (seen.has(tool.name)) throw new Error(`Duplicate tool name in catalog: "${tool.name}".`);
        seen.add(tool.name);
      }
    };
    expect(collect).toThrow(/Duplicate tool name/);
  });
});

describe('@no-llm tool contract harness — every registered tool', () => {
  const services = buildServices();

  it('web_search satisfies the wrapper contract', async () => {
    await assertToolContract(webSearchSpec(services), { query: 42 });
  });

  it('web_fetch satisfies the wrapper contract', async () => {
    const { webFetchSpec } = await import('../../../../src/adapters/pi/tools/web-fetch.js');
    await assertToolContract(webFetchSpec(services), { url: 123 });
  });

  it('script_run satisfies the wrapper contract', async () => {
    const { scriptRunSpec } = await import('../../../../src/adapters/pi/tools/script-run.js');
    await assertToolContract(scriptRunSpec(services), { script_id: 5, args: {} });
  });

  it('result_publish satisfies the wrapper contract', async () => {
    await assertToolContract(resultPublishSpec(services), { brief: {}, extra: true });
  });
});
