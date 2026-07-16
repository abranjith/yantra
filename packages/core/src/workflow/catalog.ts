/**
 * Secret-free workflow catalog projection (FEAT-027 TASK-001).
 *
 * The agentic runtime is allowed to *discover* saved workflows so it can choose
 * one for a matching goal — but it must never see the secrets, locator
 * internals, or profile paths those workflows carry. {@link projectCatalogEntry}
 * is the single chokepoint that turns a full {@link WorkflowFile} into the
 * narrow, model-visible {@link WorkflowCatalogEntry}: name, description, declared
 * params (name/type/required only), and the hosts the workflow visits.
 *
 * It **excludes by construction** the `secrets` array (both names and values),
 * the `_locators` candidate chains (and any sidecar contents), the `cookies`
 * profile mode, and every other internal field. `hosts` is derived only from
 * `navigate` steps whose URL is a literal absolute URL — template URLs that
 * depend on params cannot be resolved statically and are simply omitted rather
 * than leaked as raw expressions.
 */

import type { WorkflowFile } from '@yantra/protocol';
import { z } from 'zod';

/** One declared parameter, projected without example values or defaults. */
export const WorkflowCatalogParam = z
  .object({
    name: z.string().describe('Parameter key.'),
    type: z.enum(['string', 'number', 'boolean', 'date']).describe('Declared scalar type.'),
    required: z.boolean().describe('Whether the parameter must be supplied.'),
  })
  .strict()
  .describe('Agent-visible workflow parameter.');

export type WorkflowCatalogParam = z.infer<typeof WorkflowCatalogParam>;

/**
 * The model-visible projection of one saved workflow. This is a **closed**
 * schema (`.strict()`): no field beyond these four may cross to the agent, so a
 * future workflow attribute cannot accidentally leak into the catalog.
 */
export const WorkflowCatalogEntry = z
  .object({
    name: z.string().describe('Workflow slug name.'),
    description: z.string().describe('Human-readable description (empty string when unset).'),
    params: z.array(WorkflowCatalogParam).describe('Declared parameters in declaration order.'),
    hosts: z.array(z.string()).describe('Distinct hosts the workflow navigates to.'),
  })
  .strict()
  .describe('Secret-free, agent-visible workflow catalog entry.');

export type WorkflowCatalogEntry = z.infer<typeof WorkflowCatalogEntry>;

/**
 * Projects a full workflow into its secret-free catalog entry.
 *
 * @param workflow - The parsed workflow file.
 * @returns A model-safe entry containing only name, description, params, hosts.
 */
export function projectCatalogEntry(workflow: WorkflowFile): WorkflowCatalogEntry {
  const params: WorkflowCatalogParam[] = Object.entries(workflow.params).map(
    ([name, declaration]) => ({
      name,
      type: declaration.type,
      required: declaration.required,
    }),
  );

  return {
    name: workflow.name,
    description: workflow.description ?? '',
    params,
    hosts: deriveHosts(workflow),
  };
}

/**
 * Extracts distinct hostnames from `navigate` steps that carry a literal
 * absolute URL. Template URLs (anything not parseable as an absolute URL, e.g.
 * a `{{param}}` expression) are omitted — the catalog never surfaces raw
 * expressions or partial values.
 */
function deriveHosts(workflow: WorkflowFile): string[] {
  const hosts = new Set<string>();
  for (const step of workflow.steps) {
    if (step.verb !== 'navigate') continue;
    if (typeof step.url !== 'string') continue;
    const host = safeHost(step.url);
    if (host !== null) hosts.add(host);
  }
  return [...hosts].sort();
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
