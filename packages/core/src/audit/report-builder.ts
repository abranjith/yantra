import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TaskEvent, ToolAuditEntryType, UsageLedger } from '@yantra/protocol';

import type { AgentJsonlEntry, SecretsJsonlEntry } from './log-writer.js';

export interface FailureContext {
  readonly failureClass: string;
  readonly message: string;
}

export interface ReportBuilder {
  build(runDir: string, outcome: 'completed' | 'failed', failure?: FailureContext): Promise<string>;
}

/**
 * Builds a human-readable report from run-directory artifacts.
 *
 * Deterministic workflow runs render from `events.jsonl`/`agent.jsonl`;
 * agentic runs (manifest `runKind: "agentic"` or an `agent` section) render
 * from the stable `tool-calls.jsonl` projection and the manifest agent
 * metadata instead — agentic runs never write the legacy `agent.jsonl`.
 */
export class MarkdownReportBuilder implements ReportBuilder {
  public async build(
    runDir: string,
    outcome: 'completed' | 'failed',
    failure?: FailureContext,
  ): Promise<string> {
    const manifest = await readJson<Record<string, unknown>>(join(runDir, 'manifest.json'));
    const events = await readJsonLines<TaskEvent>(join(runDir, 'events.jsonl'));
    const secretEntries = await readJsonLines<SecretsJsonlEntry>(join(runDir, 'secrets.jsonl'));
    const usage = await readJson<UsageLedger>(join(runDir, 'usage.json'));

    const runId = runDir.split(/[/\\]/).pop() ?? runDir;
    const report = isAgenticManifest(manifest)
      ? renderAgenticReport({
          runId,
          manifest,
          events,
          toolCalls: await readJsonLines<ToolAuditEntryType>(join(runDir, 'tool-calls.jsonl')),
          secretEntries,
          usage,
          outcome,
          ...(failure ? { failure } : {}),
        })
      : renderReport({
          runId,
          manifest,
          events,
          agentEntries: await readJsonLines<AgentJsonlEntry>(join(runDir, 'agent.jsonl')),
          secretEntries,
          usage,
          outcome,
          ...(failure ? { failure } : {}),
        });

    await writeFile(join(runDir, 'report.md'), report, 'utf8');
    return report;
  }
}

function isAgenticManifest(
  manifest: Record<string, unknown> | null,
): manifest is Record<string, unknown> {
  if (manifest === null) return false;
  return (
    manifest.runKind === 'agentic' ||
    (typeof manifest.agent === 'object' && manifest.agent !== null)
  );
}

function renderAgenticReport(input: {
  readonly runId: string;
  readonly manifest: Record<string, unknown>;
  readonly events: TaskEvent[];
  readonly toolCalls: ToolAuditEntryType[];
  readonly secretEntries: SecretsJsonlEntry[];
  readonly usage: UsageLedger | null;
  readonly outcome: 'completed' | 'failed';
  readonly failure?: FailureContext;
}): string {
  const lines: string[] = [];

  const firstTs = input.events[0]?.at ?? null;
  const lastTs = input.events[input.events.length - 1]?.at ?? null;
  const durationMs = computeDurationMs(firstTs, lastTs);
  const agent = (input.manifest.agent ?? {}) as Readonly<Record<string, unknown>>;

  lines.push(`# Run ${input.runId}`);
  lines.push(`Outcome: ${input.outcome}`);
  lines.push(
    `Started: ${firstTs ?? 'n/a'}   Ended: ${lastTs ?? 'n/a'}   Duration: ${durationMs}ms`,
  );
  lines.push('');

  lines.push('## Agent Session');
  lines.push(`Provider: ${stringOr(agent.provider, 'unknown')}`);
  lines.push(`Model: ${stringOr(agent.model, 'unknown')}`);
  lines.push(
    `Adapter: ${stringOr(agent.adapter, 'unknown')} (${stringOr(agent.sdk_version, '?')})`,
  );
  lines.push(`Auth source: ${stringOr(agent.auth_source, 'unknown')}`);
  lines.push(`Prompt version: ${stringOr(agent.prompt_version, 'unknown')}`);
  lines.push('');

  lines.push('## Failure (if any)');
  if (input.failure) {
    lines.push(`Failure class: ${input.failure.failureClass}`);
    lines.push(`Cause: ${input.failure.message}`);
  } else {
    lines.push('Failure class: none');
    lines.push('Cause: n/a');
  }
  lines.push('');

  lines.push('## Tool Calls');
  const calls = summarizeToolCalls(input.toolCalls);
  if (calls.length === 0) {
    lines.push('- none');
  } else {
    for (const call of calls) {
      lines.push(
        `- [${call.seq}] ${call.tool} - ${call.status}` +
          (call.errorCode === null ? '' : ` (${call.errorCode})`) +
          (call.durationMs === null ? '' : ` - ${call.durationMs}ms`),
      );
    }
  }
  lines.push('');

  lines.push('## Agent Usage');
  if (input.usage?.agent === undefined) {
    lines.push('- none');
  } else {
    lines.push(`Turns: ${input.usage.agent.turns}`);
    lines.push(`Input tokens: ${input.usage.agent.input_tokens ?? 'unknown'}`);
    lines.push(`Output tokens: ${input.usage.agent.output_tokens ?? 'unknown'}`);
    lines.push(`Cost (USD): ${input.usage.agent.cost_usd ?? 'unknown'}`);
  }
  lines.push('');

  lines.push('## Secrets Resolved');
  const resolvedSecrets = input.secretEntries.filter((entry) => entry.outcome === 'resolved');
  if (resolvedSecrets.length === 0) {
    lines.push('- none');
  } else {
    for (const entry of resolvedSecrets) {
      lines.push(`- ${entry.key} (step ${entry.step_id})`);
    }
  }
  lines.push('');

  lines.push('## Audit Trail');
  lines.push('- tool-calls.jsonl');
  lines.push('- events.jsonl');
  lines.push('- secrets.jsonl');
  const sessionFile = stringOr(agent.session_file, '');
  if (sessionFile.length > 0) {
    lines.push(`- ${sessionFile}`);
  }

  return lines.join('\n');
}

/**
 * Collapse start/end tool lifecycle phases into one row per call, in start
 * order. A start without a matching end renders as `incomplete` — plan §7
 * requires audit rendering to identify calls the process never finished.
 */
function summarizeToolCalls(entries: ToolAuditEntryType[]): {
  readonly seq: number;
  readonly tool: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly durationMs: number | null;
}[] {
  const ends = new Map<string, ToolAuditEntryType>();
  for (const entry of entries) {
    if (entry.phase === 'end') ends.set(entry.call_id, entry);
  }
  return entries
    .filter((entry) => entry.phase === 'start')
    .map((start) => {
      const end = ends.get(start.call_id);
      return {
        seq: start.seq,
        tool: start.tool,
        status: end === undefined ? 'incomplete' : (end.status ?? 'ok'),
        errorCode: end?.error_code ?? null,
        durationMs: end?.duration_ms ?? null,
      };
    });
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function renderReport(input: {
  readonly runId: string;
  readonly manifest: Record<string, unknown> | null;
  readonly events: TaskEvent[];
  readonly agentEntries: AgentJsonlEntry[];
  readonly secretEntries: SecretsJsonlEntry[];
  readonly usage: UsageLedger | null;
  readonly outcome: 'completed' | 'failed';
  readonly failure?: FailureContext;
}): string {
  const lines: string[] = [];

  const firstTs = input.events[0]?.at ?? null;
  const lastTs = input.events[input.events.length - 1]?.at ?? null;
  const durationMs = computeDurationMs(firstTs, lastTs);

  lines.push(`# Run ${input.runId}`);
  lines.push(`Outcome: ${input.outcome}`);
  lines.push(
    `Started: ${firstTs ?? 'n/a'}   Ended: ${lastTs ?? 'n/a'}   Duration: ${durationMs}ms`,
  );
  lines.push('');

  lines.push('## Steps Timeline');
  for (const stepSummary of summarizeSteps(input.events)) {
    lines.push(
      `- [${stepSummary.stepId}] ${stepSummary.stepType} - ${stepSummary.durationMs}ms - ${stepSummary.status}`,
    );
  }
  if (summarizeSteps(input.events).length === 0) {
    lines.push('- none');
  }
  lines.push('');

  lines.push('## Failure (if any)');
  if (input.failure) {
    lines.push(`Failure class: ${input.failure.failureClass}`);
    lines.push(`Cause: ${input.failure.message}`);
  } else {
    const failedEvent = input.events.find((event) => event.kind === 'task_failed');
    if (failedEvent?.kind === 'task_failed') {
      lines.push(`Failure class: ${failedEvent.failure_class}`);
      lines.push('Cause: see report_path from task_failed event');
    } else {
      lines.push('Failure class: none');
      lines.push('Cause: n/a');
    }
  }
  lines.push('');

  const locatorFallback = summarizeLocatorFallback(input.events);
  lines.push('## Locator Fallback');
  lines.push(`Total candidate-chain attempts: ${locatorFallback.totalRetries}`);
  lines.push(`Candidates exhausted: ${locatorFallback.exhaustedRetries}`);
  lines.push('');

  lines.push('## Sanitizer');
  const sanitizerCalls = input.agentEntries.filter((e) => e.direction === 'request').length;
  lines.push(`Total sanitized payloads: ${sanitizerCalls}`);
  lines.push('');

  lines.push('## Agent Calls');
  lines.push(
    `Total LLM calls: ${input.agentEntries.filter((e) => e.direction === 'response').length}`,
  );
  const failedCalls = input.agentEntries.filter(
    (e) => e.direction === 'response' && e.outcome !== 'ok',
  );
  lines.push(`Failed calls: ${failedCalls.length}`);
  lines.push('');

  lines.push('## Agent Usage');
  if (input.usage?.agent === undefined) {
    lines.push('- none');
  } else {
    lines.push(`Turns: ${input.usage.agent.turns}`);
    lines.push(`Input tokens: ${input.usage.agent.input_tokens ?? 'unknown'}`);
    lines.push(`Output tokens: ${input.usage.agent.output_tokens ?? 'unknown'}`);
    lines.push(`Cost (USD): ${input.usage.agent.cost_usd ?? 'unknown'}`);
  }
  lines.push('');

  lines.push('## Secrets Resolved');
  const resolvedSecrets = input.secretEntries.filter((entry) => entry.outcome === 'resolved');
  if (resolvedSecrets.length === 0) {
    lines.push('- none');
  } else {
    for (const entry of resolvedSecrets) {
      lines.push(`- ${entry.key} (step ${entry.step_id})`);
    }
  }
  lines.push('');

  lines.push('## Audit Trail');
  lines.push('- agent.jsonl');
  lines.push('- secrets.jsonl');
  lines.push('- events.jsonl');

  return lines.join('\n');
}

function summarizeSteps(events: TaskEvent[]): {
  stepId: string;
  stepType: string;
  durationMs: number;
  status: 'completed' | 'failed' | 'started';
}[] {
  const started = new Map<string, { at: string; type: string }>();
  const completed = new Map<string, string>();

  for (const event of events) {
    if (event.kind === 'step_started') {
      started.set(event.step_id, { at: event.at, type: event.step_type });
    }

    if (event.kind === 'step_completed') {
      completed.set(event.step_id, event.at);
    }
  }

  return [...started.entries()].map(([stepId, info]) => {
    const doneAt = completed.get(stepId);
    return {
      stepId,
      stepType: info.type,
      durationMs: computeDurationMs(info.at, doneAt ?? null),
      status: doneAt ? 'completed' : 'started',
    };
  });
}

function summarizeLocatorFallback(events: TaskEvent[]): {
  totalRetries: number;
  exhaustedRetries: number;
} {
  const retries = events.filter((event) => event.kind === 'step_retry');
  const exhausted = retries.filter(
    (event) =>
      event.kind === 'step_retry' &&
      (event.reason === 'locator_not_found' || event.reason.includes('locator')),
  );

  return {
    totalRetries: retries.length,
    exhaustedRetries: exhausted.length,
  };
}

function computeDurationMs(startIso: string | null, endIso: string | null): number {
  if (!startIso || !endIso) {
    return 0;
  }

  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0;
  }

  return Math.max(0, end - start);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const content = await readFile(filePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}
