/**
 * Shared steps and measures for the FEAT-058 local-capture scenarios.
 *
 * Every scenario drives the synthetic `tall-page` site through the real
 * browser tools and judges the run only by what the engine recorded: the
 * outcome, the Brief's requirements and captures, `tool-calls.jsonl`, the
 * manifest, run health, and the PNG files on disk.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { type ArtifactRef, artifactRefsOf, ToolAuditEntry } from '@yantra/protocol';

import type { ScriptContext, ScriptStep } from '../agent/scripted-provider.js';
import { originOf } from '../fixtures/sites.js';
import {
  TALL_PAGE_LONG_PATH,
  TALL_PAGE_NAME_FIELD,
  TALL_PAGE_PANEL_NAME,
  TALL_PAGE_PATH,
} from '../fixtures/tall-page.js';
import type { ScenarioRun } from '../runner.js';
import type { ScenarioContract } from '../scenario.js';

import { briefOf } from './common.js';

/** The tall page's host, as a contract names it. */
export const TALL_HOST = 'tall-page.yantra.test';

/** The standard (about 9,000 px) and long (30,000 px) pages. */
export const TALL_URL = `${originOf('tall-page').replace('http:', 'https:')}${TALL_PAGE_PATH}`;
export const TALL_LONG_URL = `${originOf('tall-page').replace('http:', 'https:')}${TALL_PAGE_LONG_PATH}`;

/** The harness's ground-truth contract for a fill-and-capture goal. */
export const CAPTURE_SCENARIO_CONTRACT: ScenarioContract = {
  deliverable: 'actions',
  requiredFields: [],
  filters: [],
  requiredSources: [TALL_HOST],
};

/** The goal a capture scenario states for `url` and a screenshot of `what`. */
export function captureGoal(url: string, what: string): string {
  return `Type a name into the form at ${url} and take a screenshot of ${what}; do not submit anything.`;
}

/** The contract a faithful run declares: one page action and one screenshot of `scope`. */
export function captureContract(scope: 'viewport' | 'full_page' | 'element') {
  return {
    deliverable: 'actions',
    subject: 'the report page',
    required_sources: [TALL_HOST],
    artifacts: [{ kind: 'screenshot', scope }],
    effects: { submit: 'forbidden' },
  } as const;
}

/** Declares the contract. */
export function declareStep(params: Readonly<Record<string, unknown>>): ScriptStep {
  return { kind: 'call', tool: 'task_contract', label: 'contract', params };
}

/** Opens `url`. */
export function openStep(url: string, label = 'open page'): ScriptStep {
  return { kind: 'call', tool: 'browser_navigate', label, params: { url } };
}

/** Types a name into the form: the page action the capture must follow. */
export function fillNameStep(label = 'fill name'): ScriptStep {
  return {
    kind: 'call',
    tool: 'browser_fill_form',
    label,
    params: { fields: [{ field: TALL_PAGE_NAME_FIELD, value: 'Ada Lovelace' }] },
  };
}

/** Saves a capture of `scope`. */
export function captureStep(scope: 'viewport' | 'full_page', label = 'capture'): ScriptStep {
  return { kind: 'call', tool: 'browser_capture', label, params: { scope } };
}

/** Observes the page, so the panel's ref can be read from the result. */
export const OBSERVE_STEP: ScriptStep = {
  kind: 'call',
  tool: 'browser_observe',
  label: 'observe',
  params: {},
};

/** Captures the labeled panel below the fold, by the ref the observation offered. */
export const CAPTURE_PANEL_STEP: ScriptStep = {
  kind: 'call',
  tool: 'browser_capture',
  label: 'capture',
  params: (ctx: ScriptContext) => {
    const observation = ctx.last('browser_observe')?.model as
      | { interactables?: { ref?: unknown; name?: unknown }[] }
      | undefined;
    const ref = observation?.interactables?.find(
      (entry) => entry.name === TALL_PAGE_PANEL_NAME,
    )?.ref;
    return typeof ref === 'string' ? { scope: 'element', ref } : null;
  },
};

/** Publishes the Brief with a `fulfillment` claim. */
export function publishCaptureStep(met: boolean, unmet: readonly string[] = []): ScriptStep {
  return {
    kind: 'call',
    tool: 'result_publish',
    label: 'publish',
    params: {
      brief: {
        title: 'Report page',
        overview: 'Typed a name into the form and saved a screenshot; nothing was submitted.',
        fulfillment: {
          met,
          unmet: unmet.map((item) => ({ item, reason: 'the screenshot was not saved' })),
        },
      },
    },
  };
}

/** Every parsed end entry of `tool-calls.jsonl` for `tool`. */
export function endEntriesOf(run: ScenarioRun, tool: string): ToolAuditEntry[] {
  return (run.artifacts.toolCalls?.lines ?? []).flatMap((line) => {
    const parsed = ToolAuditEntry.safeParse(line);
    return parsed.success && parsed.data.phase === 'end' && parsed.data.tool === tool
      ? [parsed.data]
      : [];
  });
}

/** Every artifact reference in `tool-calls.jsonl`, through the one normalizer. */
export function auditRefsOf(run: ScenarioRun): ArtifactRef[] {
  return (run.artifacts.toolCalls?.lines ?? []).flatMap((line) => {
    const parsed = ToolAuditEntry.safeParse(line);
    return parsed.success && parsed.data.phase === 'end' ? artifactRefsOf(parsed.data) : [];
  });
}

/**
 * Whether every saved capture on disk hashes to the reference that cites it:
 * `{ files, matching }`, both counts.
 */
export function onDiskCaptures(run: ScenarioRun): { files: number; matching: number } {
  const dir = join(run.runDir, 'screenshots');
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.png')) : [];
  const refs = auditRefsOf(run);
  const matching = files.filter((name) => {
    const ref = refs.find((candidate) => candidate.path === `screenshots/${name}`);
    if (ref === undefined) return false;
    const sha = createHash('sha256')
      .update(readFileSync(join(dir, name)))
      .digest('hex');
    return sha === ref.sha256;
  }).length;
  return { files: files.length, matching };
}

/** Image blocks in recorded tool output and in what the scripted agent received, by tool. */
export function imageBlocksByTool(run: ScenarioRun): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  const add = (tool: string, value: unknown): void => {
    const content = (value as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return;
    const images = content.filter(
      (part) => (part as { type?: unknown } | null)?.type === 'image',
    ).length;
    if (images > 0) counts[tool] = (counts[tool] ?? 0) + images;
  };
  for (const result of run.toolResults) add(result.tool, result.audit);
  return counts;
}

/** Image blocks the stable audit trail recorded, which must carry no pixels. */
export function auditImagePayloads(run: ScenarioRun): number {
  return (run.artifacts.toolCalls?.lines ?? []).filter((line) =>
    JSON.stringify(line).includes('iVBORw0KGgo'),
  ).length;
}

/** The Brief's `artifacts`, or an empty list. */
export function briefArtifactsOf(run: ScenarioRun): readonly Record<string, unknown>[] {
  const artifacts = briefOf(run)?.artifacts;
  return Array.isArray(artifacts) ? (artifacts as Record<string, unknown>[]) : [];
}

/** The model-visible result of the call labelled `label`, or null. */
export function captureModelOf(
  run: ScenarioRun,
  label = 'capture',
): Record<string, unknown> | null {
  const result = run.toolResults.find((entry) => entry.label === label);
  return (result?.model as Record<string, unknown> | undefined) ?? null;
}
