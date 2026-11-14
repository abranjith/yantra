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

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  AgentManifestSection,
  ToolAuditEntry,
  UsageLedger,
  artifactRefsOf,
} from '@yantra/protocol';

import type { AuditRenderReport } from '../render/types.js';

export interface AuditBuilderError {
  readonly kind: 'missing' | 'corrupt';
  readonly message: string;
}

const SCOPE_KEYS = ['public', 'read-only-data', 'authenticated'] as const;

/** A slice of the tool calls or captures (FEAT-066 host windows). */
export interface AuditWindowRange {
  readonly offset: number;
  readonly limit: number;
}

/** Which rows of the long lists to materialize; the CLI passes none. */
export interface AuditWindow {
  readonly toolCalls?: AuditWindowRange;
  readonly captures?: AuditWindowRange;
}

/** A built audit and the full lengths of its windowed lists. */
export interface AuditBuildOk {
  readonly kind: 'ok';
  readonly report: AuditRenderReport;
  readonly totals: { readonly toolCalls: number; readonly captures: number };
}

export type AuditBuildResult = AuditBuildOk | { kind: 'err'; error: AuditBuilderError };

export interface AuditBuildOptions {
  /** Materialize only these rows; totals still count the whole run. */
  readonly window?: AuditWindow;
  /** The host's cache (FEAT-066); the CLI builds fresh every time. */
  readonly cache?: AuditCache;
}

function slice<T>(rows: readonly T[], range: AuditWindowRange | undefined): T[] {
  return range === undefined ? [...rows] : rows.slice(range.offset, range.offset + range.limit);
}

/**
 * Reads run-dir artifacts and synthesizes an {@link AuditRenderReport}.
 *
 * The function is tolerant of partial runs (e.g. `outputs.json` missing
 * because the run failed before writing it). Missing `manifest.json` is the
 * only fatal condition — without it we have no run identity.
 *
 * JSONL inputs are streamed line by line, so a multi-hundred-megabyte
 * `tool-calls.jsonl` never becomes one string. With a `window`, the report
 * carries only those rows of `toolCalls` and `captures`; `totals` counts all
 * of them. With a `cache`, an unchanged run directory is not read again.
 */
export async function buildAuditReport(
  runId: string,
  runDir: string,
  options: AuditBuildOptions = {},
): Promise<AuditBuildResult> {
  const full =
    options.cache === undefined
      ? await buildFull(runId, runDir)
      : await options.cache.get(runId, runDir, () => buildFull(runId, runDir));
  if (full.kind === 'err' || options.window === undefined) return full;
  return {
    kind: 'ok',
    report: {
      ...full.report,
      toolCalls: slice(full.report.toolCalls, options.window.toolCalls),
      captures: slice(full.report.captures, options.window.captures),
    },
    totals: full.totals,
  };
}

/** The whole audit, every row materialized. */
async function buildFull(runId: string, runDir: string): Promise<AuditBuildResult> {
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
  const captures = summarizeCaptures(toolEntries);
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
    captures,
    // Only an image the model saw is in the provider session log; a capture
    // kept on this computer never reached it.
    rawSessionLogCaptureBearing: captures.some((capture) => capture.sentToModel),
    usage,
    terminalError,
  };

  return {
    kind: 'ok',
    report,
    totals: { toolCalls: toolCalls.length, captures: captures.length },
  };
}

/**
 * Every capture a run's tool calls wrote, read through the one artifact
 * normalizer: a new run's `artifacts`, or an older run's `captures` (which
 * could only have been images the model saw).
 */
function summarizeCaptures(
  entries: readonly ReturnType<typeof ToolAuditEntry.parse>[],
): AuditRenderReport['captures'] {
  return [...entries]
    .sort((left, right) => left.seq - right.seq)
    .flatMap((entry) =>
      entry.phase !== 'end'
        ? []
        : artifactRefsOf(entry).map((ref) => {
            const width = ref.width ?? null;
            const height = ref.height ?? null;
            return {
              path: ref.path,
              sha256: ref.sha256,
              mimeType: ref.mime_type,
              width,
              height,
              bytes: ref.bytes,
              sentToModel: ref.sent_to_model,
              toolCall: {
                seq: entry.seq,
                callId: entry.call_id,
                tool: entry.tool,
              },
              budgetConsumed: {
                captures: 1 as const,
                pixels: width === null || height === null ? 0 : width * height,
                bytes: ref.bytes,
              },
            };
          }),
    );
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

/**
 * Every parseable line of a JSONL file, streamed: corrupt lines are skipped
 * exactly as before, and a missing file reads as empty.
 */
async function readJsonl(path: string): Promise<readonly unknown[]> {
  const out: unknown[] = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  const opened = await new Promise<boolean>((resolve) => {
    stream.once('open', () => {
      resolve(true);
    });
    stream.once('error', () => {
      resolve(false);
    });
  });
  if (!opened) return out;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // skip corrupt line
      }
    }
  } catch {
    // A read error mid-file keeps the lines read so far, as a partial run would.
  } finally {
    lines.close();
    stream.destroy();
  }
  return out;
}

/** The run files an audit reads; a change to any of them rebuilds the cached audit. */
const AUDIT_INPUTS = [
  'manifest.json',
  'secrets.jsonl',
  'events.jsonl',
  'usage.json',
  'agent.jsonl',
  'tool-calls.jsonl',
  'confirmations.jsonl',
  'schedule.json',
] as const;

/** Audits the host keeps, keyed by run directory and the sizes and times of its inputs. */
export interface AuditCache {
  get(
    runId: string,
    runDir: string,
    build: () => Promise<AuditBuildResult>,
  ): Promise<AuditBuildResult>;
}

/** Most audits the host cache keeps. */
export const AUDIT_CACHE_ENTRIES = 8;

/** The host's audit cache: an LRU of {@link AUDIT_CACHE_ENTRIES} built audits. */
export function createAuditCache(capacity = AUDIT_CACHE_ENTRIES): AuditCache {
  const entries = new Map<
    string,
    { readonly fingerprint: string; readonly result: AuditBuildResult }
  >();
  return {
    async get(runId, runDir, build) {
      const stats = await Promise.all(
        AUDIT_INPUTS.map((name) =>
          stat(join(runDir, name)).then(
            (info) => `${name}:${String(info.size)}:${String(info.mtimeMs)}`,
            () => `${name}:-`,
          ),
        ),
      );
      const key = `${runId}\u0000${runDir}`;
      const fingerprint = stats.join('|');
      const hit = entries.get(key);
      if (hit?.fingerprint === fingerprint) {
        entries.delete(key);
        entries.set(key, hit);
        return hit.result;
      }
      const result = await build();
      entries.delete(key);
      entries.set(key, { fingerprint, result });
      while (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return result;
    },
  };
}
