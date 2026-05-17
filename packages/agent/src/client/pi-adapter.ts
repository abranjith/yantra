/**
 * pi-adapter.ts — the ONLY file in the monorepo that knows pi-agent-core's
 * tool-definition shape.
 *
 * Converts packages/protocol's vendor-neutral ToolCatalog (JSON Schema based)
 * into pi-agent-core's AgentTool[] shape (Typebox based). Since pi-agent-core
 * is not installed, this adapter operates with `unknown` parameters and a
 * plain JSON Schema passthrough. When pi-agent-core is available and Typebox
 * is a peer dep, replace the `parameters` field with proper Typebox schemas.
 */

import type { ToolCatalog, ToolDefinition } from '@yantra/protocol';

import type { AgentTool, AgentToolExecuteResult, EventSink } from './pi-types.js';

// ---------------------------------------------------------------------------
// Execute hook types
// ---------------------------------------------------------------------------

export interface ExecuteHooks {
  onBeforeToolCall?: (toolName: string, input: unknown) => void;
  onAfterToolCall?: (toolName: string, input: unknown, output: unknown) => void;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Converts a vendor-neutral ToolCatalog into pi-agent-core AgentTool[].
 *
 * In MVP the agent uses tool-call extraction as an output channel, not ReAct.
 * The execute function returns a stub result — the agent emits a Plan, not
 * individual tool calls that the engine should execute.
 *
 * @param catalog - Vendor-neutral catalog from packages/protocol
 * @param executeHooks - Optional hooks for audit logging of tool calls
 */
export function toolCatalogToAgentTools(
  catalog: ToolCatalog,
  executeHooks: ExecuteHooks = {},
): AgentTool[] {
  return catalog.map((def) => toolDefinitionToAgentTool(def, executeHooks));
}

// ---------------------------------------------------------------------------
// JSON Schema → Typebox-compatible parameters
// ---------------------------------------------------------------------------

/**
 * Converts a JSON Schema object to a Typebox-compatible representation.
 *
 * Our catalog carries JSON Schema 7 (from zod-to-json-schema). Since Typebox
 * is not installed as a direct dep here, we return the JSON Schema directly
 * cast to `unknown`. Pi-agent-core accepts this when configured with
 * `jsonSchemaParsing: true` (per its README). When Typebox is needed, replace
 * this function with proper Type.* calls over the bounded schema shapes:
 * string, number, boolean, null, array, object, enum, union.
 */
function jsonSchemaToParameters(schema: unknown): unknown {
  return schema;
}

function toolDefinitionToAgentTool(def: ToolDefinition, hooks: ExecuteHooks): AgentTool {
  const parameters = jsonSchemaToParameters(def.input_schema);

  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters,
    executionMode: 'sequential' as const,
    execute(input: unknown): Promise<AgentToolExecuteResult> {
      hooks.onBeforeToolCall?.(def.name, input);
      // MVP: agent emits Plans via tool calls, not actual tool execution.
      const output: AgentToolExecuteResult = { content: [], details: {} };
      hooks.onAfterToolCall?.(def.name, input, output);
      return Promise.resolve(output);
    },
  };
}

// ---------------------------------------------------------------------------
// EventSink adapter — plumbs pi-agent-core events to our audit infrastructure
// ---------------------------------------------------------------------------

export interface AuditEventSink {
  onAgentEvent(event: { kind: string; [key: string]: unknown }): void;
}

/**
 * Creates a pi-agent-core EventSink that forwards all events to an audit sink.
 */
export function createEventSink(auditSink: AuditEventSink): EventSink {
  return {
    onEvent(event) {
      auditSink.onAgentEvent(event);
    },
  };
}
