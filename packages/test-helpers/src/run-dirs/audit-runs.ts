/**
 * Audit run-directory fixtures (FEAT-066 TASK-009): a rich agentic run, a
 * scheduled workflow run with steps and secrets, a startup failure, and a
 * large run with tens of thousands of tool calls. Vitest-free, so the e2e
 * suite can seed the same runs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HASH = 'a'.repeat(64);
const SHA = 'c'.repeat(64);

export const AGENT_SECTION = {
  adapter: 'pi-coding-agent',
  sdk_version: '0.80.6',
  provider: 'anthropic',
  model: 'claude-sonnet',
  thinking: 'medium',
  auth_source: 'environment',
  session_id: 'session-1',
  session_file: 'agent/session-1.jsonl',
  prompt_version: 'agent-v1',
  prompt_hash: HASH,
  tool_catalog_hash: HASH,
} as const;

const BASE = {
  session_id: 'session-1',
  input_sanitized: null,
  output_sanitized: null,
  status: null,
  duration_ms: null,
  error_code: null,
  confirmation_id: null,
} as const;

/** One tool-call start or end line. */
export function toolCall(
  runId: string,
  seq: number,
  callId: string,
  tool: string,
  phase: 'start' | 'end',
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ...BASE,
    run_id: runId,
    ts: new Date(Date.UTC(2026, 6, 14, 12, 0, 0, seq)).toISOString(),
    seq,
    call_id: callId,
    tool,
    phase,
    ...(phase === 'end' ? { status: 'ok', duration_ms: 10 } : {}),
    ...extra,
  };
}

/** A capture reference on a tool-call end line. */
export function captureRef(part: number, sentToModel: boolean): Record<string, unknown> {
  return {
    kind: 'screenshot',
    path: `screenshots/capture-1-${SHA.slice(0, 12)}-p${String(part)}.png`,
    sha256: SHA,
    mime_type: 'image/png',
    bytes: 4000,
    width: 1280,
    height: 4096,
    sent_to_model: sentToModel,
  };
}

function lines(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

async function write(dir: string, files: Readonly<Record<string, string>>): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

/** An agentic run: ordered calls, a denied confirmation, an incomplete call, captures, usage. */
export function writeRichAgentRun(dir: string): Promise<string> {
  const runId = 'agent-run';
  return write(dir, {
    'manifest.json': JSON.stringify({
      runId,
      workflowName: 'do',
      status: 'completed',
      startedAt: '2026-07-14T12:00:00.000Z',
      endedAt: '2026-07-14T12:00:03.000Z',
      durationMs: 3000,
      agent: AGENT_SECTION,
    }),
    'tool-calls.jsonl':
      lines([
        toolCall(runId, 0, 'a', 'web_search', 'start', { input_sanitized: { query: 'safe' } }),
        toolCall(runId, 1, 'a', 'web_search', 'end', { duration_ms: 100 }),
        toolCall(runId, 2, 'b', 'browser_click', 'start'),
        toolCall(runId, 3, 'b', 'browser_click', 'end', {
          status: 'denied',
          error_code: 'CONFIRMATION_DENIED',
          confirmation_id: 'confirm-1',
        }),
        toolCall(runId, 4, 'c', 'browser_screenshot', 'end', {
          artifacts: [captureRef(1, true), captureRef(2, false)],
        }),
        toolCall(runId, 5, 'd', 'web_fetch', 'start'),
      ]) + 'not json at all\n',
    'confirmations.jsonl': lines([{ confirmation_id: 'confirm-1', decision: 'denied' }]),
    'usage.json': JSON.stringify({
      run_id: runId,
      calls: [],
      totals: { input_tokens: 0, output_tokens: 0, cost_estimate_usd: 0, call_count: 0 },
      agent: { turns: 2, input_tokens: 20, output_tokens: 8, cost_usd: 0.04 },
    }),
    'secrets.jsonl': lines([
      { key: 'shop_password', step_id: 'fill-1', ts: '2026-07-14T12:00:01.000Z' },
    ]),
  });
}

/** A scheduled workflow run: steps with scopes, secret lookups, a schedule sidecar. */
export function writeScheduledWorkflowRun(dir: string): Promise<string> {
  return write(dir, {
    'manifest.json': JSON.stringify({
      runId: 'wf-run',
      workflowName: 'bank-statement',
      status: 'failed',
      startedAt: '2026-07-14T12:00:00.000Z',
      endedAt: null,
      durationMs: 2500,
    }),
    'events.jsonl': lines([
      { kind: 'step_started', step_id: 's1', scope: 'public' },
      { kind: 'step_started', step_id: 's2', scope: 'authenticated' },
      { kind: 'step_started', step_id: 's3', scope: 'read-only-data' },
      { kind: 'step_started', step_id: 's3', scope: 'read-only-data' },
      { kind: 'step_started', step_id: 's4' },
    ]),
    'secrets.jsonl': lines([
      { key: 'bank_user', step_id: 's2', ts: '2026-07-14T12:00:01.000Z' },
      { key: 'bank_pass', step_id: 's2', ts: '2026-07-14T12:00:01.100Z' },
    ]),
    'schedule.json': JSON.stringify({
      schedule_id: 'sched-1',
      cron_expr: '0 9 * * 1',
      fired_at: '2026-07-14T09:00:00.000Z',
      status: 'pending-confirmation',
    }),
  });
}

/** A run that failed before its provider session opened. */
export function writeStartupFailureRun(dir: string): Promise<string> {
  return write(dir, {
    'manifest.json': JSON.stringify({
      runId: 'fail-run',
      workflowName: 'research',
      status: 'failed',
      startedAt: '2026-07-14T12:00:00.000Z',
      agentError: { code: 'AGENT_AUTH_UNAVAILABLE', message: 'No credentials for anthropic.' },
    }),
  });
}

/** A run with `calls` completed tool calls (two lines each) and every tenth a capture. */
export function writeLargeRun(dir: string, calls: number): Promise<string> {
  const runId = 'big-run';
  const records: unknown[] = [];
  for (let i = 0; i < calls; i++) {
    const call = `call-${String(i)}`;
    records.push(toolCall(runId, i * 2, call, 'web_fetch', 'start'));
    records.push(
      toolCall(runId, i * 2 + 1, call, i % 10 === 0 ? 'browser_screenshot' : 'web_fetch', 'end', {
        ...(i % 10 === 0 ? { artifacts: [captureRef(1, false)] } : {}),
      }),
    );
  }
  return write(dir, {
    'manifest.json': JSON.stringify({
      runId,
      workflowName: 'do',
      status: 'completed',
      startedAt: '2026-07-14T12:00:00.000Z',
      agent: AGENT_SECTION,
    }),
    'tool-calls.jsonl': lines(records),
  });
}
