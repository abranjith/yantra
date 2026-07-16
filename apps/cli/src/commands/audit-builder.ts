/**
 * Builds the structured audit report consumed by `yantra audit <run-id>`.
 *
 * Pure-function, read-only: ingests `manifest.json`, `tool-calls.jsonl`,
 * `usage.json`, `secrets.jsonl`, and `events.jsonl` from the run directory
 * and synthesizes an {@link AuditRenderReport}. No browser, no network, no
 * mutation of the run dir.
 *
 * The "trust narrative" is the headline 2–3 sentence prose summary that
 * makes the audit human-readable. We compose it from the structured fields
 * here so both terminal and JSON renderers see the same text.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentManifestSection, ToolAuditEntry, UsageLedger } from '@yantra/protocol';

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

  const secretEntries = await readJsonl(join(runDir, 'secrets.jsonl'));
  const eventEntries = await readJsonl(join(runDir, 'events.jsonl'));

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
    agent?: unknown;
    agentError?: unknown;
  };
  const parsedAgent = AgentManifestSection.safeParse(manifestObj.agent);
  const agent = parsedAgent.success
    ? {
        adapter: parsedAgent.data.adapter,
        sdkVersion: parsedAgent.data.sdk_version,
        provider: parsedAgent.data.provider,
        model: parsedAgent.data.model,
        thinking: parsedAgent.data.thinking,
        authSource: parsedAgent.data.auth_source,
        sessionId: parsedAgent.data.session_id,
        sessionFile: parsedAgent.data.session_file,
        promptVersion: parsedAgent.data.prompt_version,
      }
    : null;
  const usageLedger = UsageLedger.safeParse(await readJsonFile(join(runDir, 'usage.json')));
  const usage = usageLedger.success
    ? usageLedger.data.agent === undefined
      ? null
      : {
          turns: usageLedger.data.agent.turns,
          inputTokens: usageLedger.data.agent.input_tokens,
          outputTokens: usageLedger.data.agent.output_tokens,
          costUsd: usageLedger.data.agent.cost_usd,
        }
    : null;
  const legacyAgentEntries = agent === null ? await readJsonl(join(runDir, 'agent.jsonl')) : [];
  const llmCallCount =
    usage?.turns ??
    legacyAgentEntries.filter((entry) => (entry as { direction?: string }).direction === 'response')
      .length;
  const toolEntries = (await readJsonl(join(runDir, 'tool-calls.jsonl'))).flatMap((entry) => {
    const parsed = ToolAuditEntry.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const confirmations = await readJsonl(join(runDir, 'confirmations.jsonl'));
  const toolCalls = summarizeToolCalls(toolEntries, confirmations);
  const terminalError = readTerminalError(manifestObj.agentError);
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
    agent,
    toolCalls,
    usage,
    terminalError,
  };

  return { kind: 'ok', report };
}

function summarizeToolCalls(
  entries: readonly ReturnType<typeof ToolAuditEntry.parse>[],
  confirmationEntries: readonly unknown[],
): AuditRenderReport['toolCalls'] {
  const decisions = new Map<string, string>();
  for (const entry of confirmationEntries) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Readonly<Record<string, unknown>>;
    if (typeof record.confirmation_id === 'string' && typeof record.decision === 'string') {
      decisions.set(record.confirmation_id, record.decision);
    }
  }

  const calls = new Map<
    string,
    {
      seq: number;
      callId: string;
      tool: string;
      status: 'ok' | 'error' | 'denied' | 'aborted' | 'incomplete';
      durationMs: number | null;
      confirmationId: string | null;
      confirmationDecision: string | null;
      incomplete: boolean;
    }
  >();

  for (const entry of [...entries].sort((left, right) => left.seq - right.seq)) {
    if (entry.phase === 'start') {
      calls.set(entry.call_id, {
        seq: entry.seq,
        callId: entry.call_id,
        tool: entry.tool,
        status: 'incomplete',
        durationMs: null,
        confirmationId: null,
        confirmationDecision: null,
        incomplete: true,
      });
      continue;
    }
    const existing = calls.get(entry.call_id);
    const confirmationId = entry.confirmation_id;
    calls.set(entry.call_id, {
      seq: existing?.seq ?? entry.seq,
      callId: entry.call_id,
      tool: existing?.tool ?? entry.tool,
      status: entry.status ?? 'error',
      durationMs: entry.duration_ms,
      confirmationId,
      confirmationDecision:
        confirmationId === null ? null : (decisions.get(confirmationId) ?? null),
      incomplete: false,
    });
  }
  return [...calls.values()].sort((left, right) => left.seq - right.seq);
}

function readTerminalError(value: unknown): { code: string; message: string } | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Readonly<Record<string, unknown>>;
  const code = readString(record.code);
  const message = readString(record.message);
  return code === undefined || message === undefined ? null : { code, message };
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
