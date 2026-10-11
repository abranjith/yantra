/**
 * Shared building blocks for the scenario catalogue: script steps, measure
 * helpers, and the cross-cutting expectations every scenario carries.
 *
 * Measures are pure reads of a completed {@link ScenarioRun}. They read only
 * what a run actually produced — tool results as the agent received them,
 * public artifacts, and the harness's own independent counts — and they
 * normalize "absent" to `null`, so a baseline can say precisely that a field
 * does not exist yet.
 */

import { RunHealth } from '@yantra/protocol';

import type { ReceivedResult, ScriptStep } from '../agent/scripted-provider.js';
import { equals, type Expectation } from '../expectations.js';
import type { RequestLogEntry } from '../fixtures/server.js';
import type { ScenarioRun } from '../runner.js';

// ---------------------------------------------------------------------------
// Script steps
// ---------------------------------------------------------------------------

/** A `web_fetch` of a fixed URL (a URL the goal or a fixture origin supplies). */
export function fetchStep(url: string, label = 'web_fetch'): ScriptStep {
  return { kind: 'call', tool: 'web_fetch', label, params: { url } };
}

/** A `web_search` for `query`, with an optional `limit`. */
export function searchStep(query: string, label = 'web_search', limit?: number): ScriptStep {
  return {
    kind: 'call',
    tool: 'web_search',
    label,
    params: limit === undefined ? { query } : { query, limit },
  };
}

/**
 * The script's terminal publication: a plain Brief, the only shape
 * `result_publish` accepts today. The scripted agent does not reason about
 * content; scoring the delivered rows is the agentic tier's job.
 */
export function publishStep(title: string, overview: string): ScriptStep {
  return {
    kind: 'call',
    tool: 'result_publish',
    label: 'publish',
    params: { brief: { title, overview } },
  };
}

// ---------------------------------------------------------------------------
// Measure helpers
// ---------------------------------------------------------------------------

/** Results the scripted agent received for steps labelled `label`, in call order. */
export function resultsLabelled(run: ScenarioRun, label: string): readonly ReceivedResult[] {
  return run.toolResults.filter((result) => result.label === label);
}

/** The single result labelled `label`, or null when the step never ran. */
export function resultLabelled(run: ScenarioRun, label: string): ReceivedResult | null {
  return resultsLabelled(run, label)[0] ?? null;
}

/** The model-visible payload as an object, or null. */
export function modelOf(result: ReceivedResult | null): Readonly<Record<string, unknown>> | null {
  const model = result?.model;
  return typeof model === 'object' && model !== null && !Array.isArray(model)
    ? (model as Record<string, unknown>)
    : null;
}

/** A payload field, with "absent" normalized to null. */
export function fieldOf(result: ReceivedResult | null, name: string): unknown {
  return modelOf(result)?.[name] ?? null;
}

/** A payload array field, or null when the result carries no such array. */
export function arrayOf(result: ReceivedResult | null, name: string): readonly unknown[] | null {
  const value = fieldOf(result, name);
  return Array.isArray(value) ? value : null;
}

/** True when `text` appears anywhere in the result's model-visible payload. */
export function payloadIncludes(result: ReceivedResult | null, text: string): boolean {
  return result?.modelText.includes(text) === true;
}

/** A string property of an untyped payload entry, or `''` when absent or not a string. */
export function stringProp(entry: unknown, name: string): string {
  const value = (entry as Record<string, unknown> | null)?.[name];
  return typeof value === 'string' ? value : '';
}

/** The status and error code of a result, or null when the step never ran. */
export function outcomeOf(
  result: ReceivedResult | null,
): { readonly status: string; readonly errorCode: string | null } | null {
  return result === null ? null : { status: result.status, errorCode: result.errorCode };
}

/** Fixture requests for documents: robots, favicons, and script assets excluded. */
export function documentRequests(run: ScenarioRun): readonly RequestLogEntry[] {
  return run.requests.filter(
    (entry) => !entry.robots && entry.path !== '/favicon.ico' && !entry.path.endsWith('.js'),
  );
}

/** Document requests the fixture server received for `url` (path and query must match). */
export function requestsFor(run: ScenarioRun, url: string): number {
  const target = new URL(url);
  const query = target.search.replace(/^\?/, '');
  return documentRequests(run).filter(
    (entry) =>
      entry.host === target.hostname && entry.path === target.pathname && entry.query === query,
  ).length;
}

/** Document requests that arrived while `result`'s call was in flight. */
export function requestsDuring(run: ScenarioRun, result: ReceivedResult | null): number {
  if (result === null) return 0;
  return documentRequests(run).filter(
    (entry) => entry.at >= result.startedAt && entry.at <= result.endedAt,
  ).length;
}

/** The most document requests any one URL received. */
export function maxRequestsPerUrl(run: ScenarioRun): number {
  const counts = new Map<string, number>();
  for (const entry of documentRequests(run)) {
    const key = `${entry.host}${entry.path}?${entry.query}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

/** The published Brief, loosely typed, or null. */
export function briefOf(run: ScenarioRun): Readonly<Record<string, unknown>> | null {
  const brief = run.artifacts.brief;
  return typeof brief === 'object' && brief !== null ? (brief as Record<string, unknown>) : null;
}

/** The Brief's notices as `{ kind, source }`, in order. */
export function noticesOf(
  run: ScenarioRun,
): readonly { readonly kind: string; readonly source: string }[] {
  const notices = briefOf(run)?.notices;
  if (!Array.isArray(notices)) return [];
  return notices.flatMap((notice: unknown) => {
    if (typeof notice !== 'object' || notice === null) return [];
    const { kind, source } = notice as { kind?: unknown; source?: unknown };
    return typeof kind === 'string' && typeof source === 'string' ? [{ kind, source }] : [];
  });
}

/** The URLs the Brief lists as sources. */
export function sourceUrlsOf(run: ScenarioRun): readonly string[] {
  const sources = briefOf(run)?.sources;
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((source: unknown) => {
    const url = (source as { url?: unknown } | null)?.url;
    return typeof url === 'string' ? [url] : [];
  });
}

/** `run-health.json`, loosely typed, or null. */
export function healthOf(run: ScenarioRun): Readonly<Record<string, unknown>> | null {
  const health = run.artifacts.runHealth;
  return typeof health === 'object' && health !== null ? (health as Record<string, unknown>) : null;
}

/** Runtime-log lines whose `event` is `name`. */
export function runtimeEvents(run: ScenarioRun, name: string): readonly Record<string, unknown>[] {
  return (run.artifacts.runtime?.lines ?? []).filter(
    (line): line is Record<string, unknown> =>
      typeof line === 'object' && line !== null && (line as { event?: unknown }).event === name,
  );
}

// ---------------------------------------------------------------------------
// Cross-cutting expectations
// ---------------------------------------------------------------------------

/**
 * The four expectations every scenario carries: the audit artifacts parse, no
 * canary leaked, nothing left the loopback mapping, and `run-health.json`
 * validates when present.
 */
export function crossCuttingExpectations(): readonly Expectation[] {
  return [
    {
      id: 'audit-lines-parse',
      owner: 'FEAT-048',
      measure: (run) => ({
        toolCalls: run.artifacts.toolCalls?.unparseable ?? 'missing',
        runtime: run.artifacts.runtime?.unparseable ?? 'missing',
      }),
      target: equals({ toolCalls: [], runtime: [] }),
      note: 'G8 / §11: every tool-calls.jsonl and runtime.jsonl line parses.',
    },
    {
      id: 'canary-scan-clean',
      owner: 'current',
      measure: (run) => ({ files: run.canaryHits, runtimeLog: run.runtimeLogFindings }),
      target: equals({ files: [], runtimeLog: [] }),
      note: 'Security: no planted canary in any run file; runtime.jsonl passes the safety scanner.',
    },
    {
      id: 'no-egress',
      owner: 'current',
      measure: (run) => run.egress,
      target: equals([]),
      note: 'Hermeticity: zero requests left the loopback mapping.',
    },
    {
      id: 'run-health-validates',
      owner: 'FEAT-048',
      measure: (run) =>
        run.artifacts.runHealth === null
          ? 'absent'
          : RunHealth.safeParse(run.artifacts.runHealth).success,
      target: equals(true),
      note: 'FEAT-048: run-health.json is written and validates against the protocol schema.',
    },
  ];
}
