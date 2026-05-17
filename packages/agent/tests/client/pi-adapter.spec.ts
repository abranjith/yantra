/**
 * @no-llm Tests for the ToolCatalog → AgentTool adapter.
 */
import type { ToolCatalog } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { toolCatalogToAgentTools } from '../../src/client/pi-adapter.js';

const SAMPLE_CATALOG: ToolCatalog = [
  {
    name: 'navigate',
    description: 'Navigate to a URL.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } } },
    output_schema: null,
  },
  {
    name: 'click',
    description: 'Click a UI element.',
    input_schema: { type: 'object', properties: { locator: { type: 'string' } } },
    output_schema: null,
  },
];

describe('toolCatalogToAgentTools()', () => {
  it('converts each ToolDefinition to an AgentTool', () => {
    const tools = toolCatalogToAgentTools(SAMPLE_CATALOG);
    expect(tools).toHaveLength(2);
  });

  it('preserves name and description', () => {
    const tools = toolCatalogToAgentTools(SAMPLE_CATALOG);
    const nav = tools.find((t) => t.name === 'navigate');
    expect(nav?.name).toBe('navigate');
    expect(nav?.description).toBe('Navigate to a URL.');
  });

  it('label equals name', () => {
    const tools = toolCatalogToAgentTools(SAMPLE_CATALOG);
    for (const tool of tools) {
      expect(tool.label).toBe(tool.name);
    }
  });

  it('each tool has an execute function', () => {
    const tools = toolCatalogToAgentTools(SAMPLE_CATALOG);
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('execute returns a stub result with empty content', async () => {
    const tools = toolCatalogToAgentTools(SAMPLE_CATALOG);
    const navTool = tools.find((t) => t.name === 'navigate')!;
    const result = await navTool.execute({ url: 'https://example.com' });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(0);
  });

  it('calls execute hooks in order', async () => {
    const calls: string[] = [];
    const hooks = {
      onBeforeToolCall: (name: string) => calls.push(`before:${name}`),
      onAfterToolCall: (name: string) => calls.push(`after:${name}`),
    };

    const tools = toolCatalogToAgentTools(SAMPLE_CATALOG, hooks);
    const navTool = tools.find((t) => t.name === 'navigate')!;
    await navTool.execute({});

    expect(calls).toEqual(['before:navigate', 'after:navigate']);
  });

  it('handles empty catalog', () => {
    expect(() => toolCatalogToAgentTools([])).not.toThrow();
    expect(toolCatalogToAgentTools([])).toHaveLength(0);
  });
});
