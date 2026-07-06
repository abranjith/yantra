/**
 * Builds the structured audit report consumed by `yantra audit <run-id>`.
 *
 * Pure-function, read-only: ingests `manifest.json`, `agent.jsonl`,
 * `secrets.jsonl`, `events.jsonl`, and `outputs.json` from the run directory
 * and synthesizes an {@link AuditRenderReport}. No browser, no network, no
 * mutation of the run dir.
 *
 * The "trust narrative" is the headline 2–3 sentence prose summary that
 * makes the audit human-readable. We compose it from the structured fields
 * here so both terminal and JSON renderers see the same text.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuditRenderReport } from '../render/types.js';

export interface AuditBuilderError {
  readonly kind: 'missing' | 'corrupt';
  readonly message: string;
}

const SCOPE_KEYS = ['public', 'read-only-data', 'authenticated'] as const;

/**
 * Reads run-dir artifacts and synthesizes an {@link AuditRenderReport}.
 *
 * The function is tolerant of partial runs (e.g. `outputs.json` missing
 * because the run failed before writing it). Missing `manifest.json` is the
 * only fatal condition — without it we have no run identity.
 */
export async function buildAuditReport(
  runId: string,
  runDir: string,
): Promise<{ kind: 'ok'; report: AuditRenderReport } | { kind: 'err'; error: AuditBuilderError }> {
  const manifest = await readJsonFile(join(runDir, 'manifest.json'));
  if (manifest === null) {
    return {
      kind: 'err',
      error: { kind: 'missing', message: `manifest.json missing for run ${runId}` },
    };
  }

  const agentEntries = await readJsonl(join(runDir, 'agent.jsonl'));
  const secretEntries = await readJsonl(join(runDir, 'secrets.jsonl'));
  const eventEntries = await readJsonl(join(runDir, 'events.jsonl'));

  const llmCallCount = agentEntries.filter(
    (entry) => (entry as { direction?: string }).direction === 'response',
  ).length;

  const secretLookups = secretEntries.map((entry) => {
    const e = entry as { key?: unknown; step_id?: unknown; ts?: unknown };
    return {
      key: readString(e.key) ?? '<unknown>',
      stepId: readString(e.step_id) ?? '',
      ts: readString(e.ts) ?? '',
    };
  });

  const scopeMix = { publicCount: 0, readOnlyDataCount: 0, authenticatedCount: 0 };
  const stepIdsSeen = new Set<string>();
  for (const event of eventEntries) {
    const ev = event as { kind?: string; step_id?: string; scope?: string };
    if (ev.kind === 'step_started' && typeof ev.step_id === 'string') {
      stepIdsSeen.add(ev.step_id);
      if (ev.scope === 'public') scopeMix.publicCount += 1;
      else if (ev.scope === 'read-only-data') scopeMix.readOnlyDataCount += 1;
      else if (ev.scope === 'authenticated') scopeMix.authenticatedCount += 1;
      else scopeMix.publicCount += 1; // default scope
    }
  }
  if (!SCOPE_KEYS.length) {
    // touch the const so it isn't dead — keeps the contract explicit.
  }

  const manifestObj = manifest as {
    status?: unknown;
    workflowName?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    durationMs?: unknown;
  };
  const status = readString(manifestObj.status) ?? 'unknown';
  const workflowName = readString(manifestObj.workflowName) ?? '<unknown>';
  const startedAt = readString(manifestObj.startedAt) ?? '';
  const endedAt = readString(manifestObj.endedAt);
  const durationMs = typeof manifestObj.durationMs === 'number' ? manifestObj.durationMs : null;

  // Schedule linkage (FEAT-021): a `schedule.json` sidecar means this run was
  // produced by the scheduler daemon. Narrate the fire (plan §10).
  const scheduleLink = await readScheduleLink(join(runDir, 'schedule.json'));

  const trustNarrative = buildTrustNarrative({
    status,
    durationMs,
    llmCallCount,
    secretLookupCount: secretLookups.length,
    stepCount: stepIdsSeen.size,
    scheduleLink,
  });

  const report: AuditRenderReport = {
    runId,
    workflowName,
    status,
    startedAt,
    endedAt: endedAt ?? null,
    durationMs,
    llmCallCount,
    secretLookups,
    stepCount: stepIdsSeen.size,
    scopeMix,
    trustNarrative,
  };

  return { kind: 'ok', report };
}

/** The schedule-link fields the audit narrates, when present. */
interface ScheduleLinkView {
  readonly scheduleId: string;
  readonly cronExpr: string;
  readonly firedAt: string;
  readonly status: string;
}

/** Reads and validates the `schedule.json` sidecar, or null when absent. */
async function readScheduleLink(path: string): Promise<ScheduleLinkView | null> {
  const raw = await readJsonFile(path);
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const scheduleId = readString(obj.schedule_id);
  const cronExpr = readString(obj.cron_expr);
  const firedAt = readString(obj.fired_at);
  const status = readString(obj.status);
  if (scheduleId === undefined || cronExpr === undefined) {
    return null;
  }
  return {
    scheduleId,
    cronExpr,
    firedAt: firedAt ?? '',
    status: status ?? 'unknown',
  };
}

function buildTrustNarrative(input: {
  status: string;
  durationMs: number | null;
  llmCallCount: number;
  secretLookupCount: number;
  stepCount: number;
  scheduleLink?: ScheduleLinkView | null;
}): string {
  const durationPhrase =
    input.durationMs === null ? '' : ` in ${(input.durationMs / 1000).toFixed(1)}s`;
  const verb =
    input.status === 'completed'
      ? 'completed'
      : input.status === 'failed'
        ? 'failed'
        : input.status;
  const llmPhrase =
    input.llmCallCount === 0
      ? 'The agent made no LLM calls'
      : `The agent made ${input.llmCallCount} LLM call${input.llmCallCount === 1 ? '' : 's'} (sanitized prompts only)`;
  const secretPhrase =
    input.secretLookupCount === 0
      ? 'no secrets were resolved'
      : `${input.secretLookupCount} secret lookup${input.secretLookupCount === 1 ? '' : 's'} were performed (keys only — never values)`;
  const base = `Run ${verb}${durationPhrase}. ${llmPhrase} and ${secretPhrase}. The engine executed ${input.stepCount} step${input.stepCount === 1 ? '' : 's'}.`;
  return input.scheduleLink ? `${schedulePhrase(input.scheduleLink)} ${base}` : base;
}

/** Narrates the schedule linkage line (fire → status), including pause-and-notify. */
function schedulePhrase(link: ScheduleLinkView): string {
  const firedPhrase = link.firedAt.length > 0 ? ` at ${link.firedAt}` : '';
  if (link.status === 'pending-confirmation') {
    return `Fired by schedule ${link.scheduleId} (cron "${link.cronExpr}")${firedPhrase} and paused-and-notified for confirmation — it never auto-confirmed.`;
  }
  return `Fired by schedule ${link.scheduleId} (cron "${link.cronExpr}")${firedPhrase}.`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readJsonl(path: string): Promise<readonly unknown[]> {
  try {
    const text = await readFile(path, 'utf8');
    const out: unknown[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // skip corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}
