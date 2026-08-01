/**
 * `createYantraTools` — the per-run tool factory (FEAT-024 TASK-003,
 * plan_agentic.md §5).
 *
 * This is the ONLY file that turns Yantra's provider-neutral tool specs into
 * concrete Pi `defineTool` definitions. It enforces unique names and a
 * deterministic name-sorted ordering (so `tool_catalog_hash` is stable), and it
 * routes every Pi tool call through the mandatory middleware pipeline. The Pi
 * SDK is imported only here (and elsewhere under `adapters/pi/`), never in the
 * provider-neutral runtime.
 */

import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

import type { HashableToolDefinition } from '../../../runtime/catalog-hash.js';
import { wrapTool, type WrappedTool, type YantraToolResult } from '../../../runtime/middleware.js';
import type { CommandTaskProfile, YantraToolName } from '../../../runtime/profiles.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { browserClickSpec } from './browser-click.js';
import { browserExtractSpec } from './browser-extract.js';
import { browserFillSpec } from './browser-fill.js';
import { browserNavigateSpec } from './browser-navigate.js';
import { browserObserveSpec } from './browser-observe.js';
import { resultPublishSpec } from './result-publish.js';
import { scriptRunSpec } from './script-run.js';
import { webFetchSpec } from './web-fetch.js';
import { webSearchSpec } from './web-search.js';
import { workflowRunSpec } from './workflow-run.js';

export {
  createBriefPublisher,
  createTemplatedReportPublisher,
  evidenceToSourceRecords,
  type BriefPublisherContext,
  type TemplatedReportPublisherContext,
} from './result-publish.js';
export { webSearchSpec } from './web-search.js';
export { webFetchSpec } from './web-fetch.js';
export { scriptRunSpec } from './script-run.js';
export { resultPublishSpec } from './result-publish.js';
export { templateParamsFor } from './template-params.js';
export { validateSlots, type TemplateSlotIssue } from './template-validate.js';
export { browserClickSpec } from './browser-click.js';
export { browserExtractSpec } from './browser-extract.js';
export { browserFillSpec } from './browser-fill.js';
export { browserNavigateSpec } from './browser-navigate.js';
export { browserObserveSpec } from './browser-observe.js';
export { workflowRunSpec } from './workflow-run.js';

/**
 * Assemble the run's wrapped tools: build each spec, wrap it with the mandatory
 * middleware, reject duplicate names, and sort by name for deterministic
 * ordering (the ordering feeds `tool_catalog_hash`).
 *
 * @param services The per-run dependency bundle.
 * @returns Provider-neutral wrapped tools, sorted by name, unique.
 */
export function buildYantraWrappedTools(
  services: RunServices,
  profile?: Pick<CommandTaskProfile, 'toolNames' | 'workflowToolMode'>,
): WrappedTool[] {
  const toolServices = profile
    ? { ...services, workflowToolMode: profile.workflowToolMode }
    : services;
  // Each spec has a distinct parameter schema, so wrap them individually (a
  // heterogeneous spec array would collapse the generic parameter to a union).
  const allWrapped: WrappedTool[] = [
    wrapTool(browserNavigateSpec(toolServices), toolServices),
    wrapTool(browserObserveSpec(toolServices), toolServices),
    wrapTool(browserClickSpec(toolServices), toolServices),
    wrapTool(browserFillSpec(toolServices), toolServices),
    wrapTool(browserExtractSpec(toolServices), toolServices),
    wrapTool(webSearchSpec(toolServices), toolServices),
    wrapTool(webFetchSpec(toolServices), toolServices),
    wrapTool(scriptRunSpec(toolServices), toolServices),
    wrapTool(workflowRunSpec(toolServices), toolServices),
    wrapTool(resultPublishSpec(toolServices), toolServices),
  ];

  const allowed = profile ? new Set<YantraToolName>(profile.toolNames) : null;
  const wrapped = allowed
    ? allWrapped.filter((tool) => allowed.has(tool.name as YantraToolName))
    : allWrapped;
  const seen = new Set<string>();
  for (const tool of wrapped) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name in catalog: "${tool.name}".`);
    }
    seen.add(tool.name);
  }

  return wrapped.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Build the concrete Pi tool definitions for one run.
 *
 * @param services The per-run dependency bundle.
 * @returns Pi `ToolDefinition`s in deterministic name order.
 */
export function createYantraTools(
  services: RunServices,
  profile?: Pick<CommandTaskProfile, 'toolNames' | 'workflowToolMode'>,
): ToolDefinition[] {
  return buildYantraWrappedTools(services, profile).map(toPiTool);
}

/**
 * The stable catalog description used for `tool_catalog_hash` (FEAT-023).
 * Derived from the same wrapped tools so the hash matches the active catalog.
 *
 * @param services The per-run dependency bundle.
 * @returns Name/schema/description triples in deterministic name order.
 */
export function yantraToolCatalog(
  services: RunServices,
  profile?: Pick<CommandTaskProfile, 'toolNames' | 'workflowToolMode'>,
): HashableToolDefinition[] {
  return buildYantraWrappedTools(services, profile).map((tool) => ({
    name: tool.name,
    schema: tool.parameters,
    description: tool.description,
  }));
}

/** Map one provider-neutral wrapped tool onto a Pi `defineTool` definition. */
function toPiTool(tool: WrappedTool): ToolDefinition {
  return defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId, params, signal) => {
      const result = await tool.execute(params, signal);
      return toAgentToolResult(result);
    },
  });
}

/**
 * Map the neutral {@link YantraToolResult} onto Pi's `AgentToolResult`, carrying
 * the audit metadata (status/error_code/confirmation_id) as top-level fields so
 * the run recorder can project it into `tool-calls.jsonl` without parsing text.
 */
function toAgentToolResult(result: YantraToolResult): AgentToolResult<unknown> {
  const out = {
    content: [{ type: 'text' as const, text: result.modelText }],
    details: result.details ?? null,
    status: result.status,
    ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
    ...(result.confirmation_id !== undefined ? { confirmation_id: result.confirmation_id } : {}),
    ...(result.terminate === true ? { terminate: true } : {}),
  };
  // The extra audit fields are intentional (read by the FEAT-023 recorder); Pi
  // ignores unknown fields on the result object.
  return out;
}
