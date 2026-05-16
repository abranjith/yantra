import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TaskEvent } from '@yantra/protocol';

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
 */
export class MarkdownReportBuilder implements ReportBuilder {
  public async build(
    runDir: string,
    outcome: 'completed' | 'failed',
    failure?: FailureContext,
  ): Promise<string> {
    const manifest = await readJson<Record<string, unknown>>(join(runDir, 'manifest.json'));
    const events = await readJsonLines<TaskEvent>(join(runDir, 'events.jsonl'));
    const agentEntries = await readJsonLines<AgentJsonlEntry>(join(runDir, 'agent.jsonl'));
    const secretEntries = await readJsonLines<SecretsJsonlEntry>(join(runDir, 'secrets.jsonl'));

    const report = renderReport({
      runId: runDir.split(/[/\\]/).pop() ?? runDir,
      manifest,
      events,
      agentEntries,
      secretEntries,
      outcome,
      ...(failure ? { failure } : {}),
    });

    await writeFile(join(runDir, 'report.md'), report, 'utf8');
    return report;
  }
}

function renderReport(input: {
  readonly runId: string;
  readonly manifest: Record<string, unknown> | null;
  readonly events: TaskEvent[];
  readonly agentEntries: AgentJsonlEntry[];
  readonly secretEntries: SecretsJsonlEntry[];
  readonly outcome: 'completed' | 'failed';
  readonly failure?: FailureContext;
}): string {
  const lines: string[] = [];

  const firstTs = input.events[0]?.at ?? null;
  const lastTs = input.events[input.events.length - 1]?.at ?? null;
  const durationMs = computeDurationMs(firstTs, lastTs);

  lines.push(`# Run ${input.runId}`);
  lines.push(`Outcome: ${input.outcome}`);
  lines.push(`Started: ${firstTs ?? 'n/a'}   Ended: ${lastTs ?? 'n/a'}   Duration: ${durationMs}ms`);
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
  lines.push(`Transformations applied: ${JSON.stringify(summarizeTransformations(input.agentEntries))}`);
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

function summarizeTransformations(agentEntries: AgentJsonlEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const entry of agentEntries) {
    for (const transformation of entry.transformations_applied) {
      counts[transformation] = (counts[transformation] ?? 0) + 1;
    }
  }

  return counts;
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
