import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAuditReport } from './audit-builder.js';

async function makeRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'yantra-audit-builder-'));
}

describe('@no-llm cli/audit-builder', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await makeRunDir();
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('returns a missing error when manifest.json is absent', async () => {
    const result = await buildAuditReport('test-run', runDir);
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('missing');
      expect(result.error.message).toContain('manifest.json');
    }
  });

  it('synthesizes a structured report from run-dir artifacts', async () => {
    const manifest = {
      runId: 'test-run',
      workflowName: 'bank-statement',
      status: 'completed',
      startedAt: '2026-05-16T12:00:00.000Z',
      endedAt: '2026-05-16T12:00:05.123Z',
      durationMs: 5123,
    };
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    const agentLines = [
      JSON.stringify({ direction: 'request', model: 'claude-opus-4-7' }),
      JSON.stringify({ direction: 'response', model: 'claude-opus-4-7', outcome: 'ok' }),
    ];
    await writeFile(join(runDir, 'agent.jsonl'), `${agentLines.join('\n')}\n`, 'utf8');

    const secretLines = [
      JSON.stringify({ key: 'bank.password', step_id: 's3', ts: '2026-05-16T12:00:01Z' }),
      JSON.stringify({ key: 'bank.username', step_id: 's2', ts: '2026-05-16T12:00:00Z' }),
    ];
    await writeFile(join(runDir, 'secrets.jsonl'), `${secretLines.join('\n')}\n`, 'utf8');

    const eventLines = [
      JSON.stringify({ kind: 'step_started', step_id: 's1', scope: 'public' }),
      JSON.stringify({ kind: 'step_started', step_id: 's2', scope: 'authenticated' }),
      JSON.stringify({ kind: 'step_started', step_id: 's3', scope: 'read-only-data' }),
    ];
    await writeFile(join(runDir, 'events.jsonl'), `${eventLines.join('\n')}\n`, 'utf8');

    const result = await buildAuditReport('test-run', runDir);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.report.runId).toBe('test-run');
    expect(result.report.workflowName).toBe('bank-statement');
    expect(result.report.status).toBe('completed');
    expect(result.report.durationMs).toBe(5123);
    expect(result.report.llmCallCount).toBe(1);
    expect(result.report.secretLookups).toHaveLength(2);
    expect(result.report.secretLookups[0]?.key).toBe('bank.password');
    expect(result.report.stepCount).toBe(3);
    expect(result.report.scopeMix.publicCount).toBe(1);
    expect(result.report.scopeMix.authenticatedCount).toBe(1);
    expect(result.report.scopeMix.readOnlyDataCount).toBe(1);
    expect(result.report.trustNarrative).toContain('completed');
    expect(result.report.trustNarrative).toContain('1 LLM call');
    expect(result.report.trustNarrative).toContain('2 secret lookup');
  });

  it('narrates a scheduled fire (with pause-and-notify) from the schedule.json sidecar', async () => {
    const manifest = {
      runId: 'sched-run',
      workflowName: 'weekly-report',
      status: 'paused',
      startedAt: '2026-07-05T08:00:00.000Z',
      endedAt: '2026-07-05T08:00:02.000Z',
      durationMs: 2000,
    };
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(
      join(runDir, 'schedule.json'),
      JSON.stringify({
        schedule_id: 'SCH123',
        workflow_name: 'weekly-report',
        cron_expr: '0 8 * * 1',
        fired_at: '2026-07-05T08:00:00.000Z',
        status: 'pending-confirmation',
      }),
      'utf8',
    );

    const result = await buildAuditReport('sched-run', runDir);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.trustNarrative).toContain('Fired by schedule SCH123');
    expect(result.report.trustNarrative).toContain('0 8 * * 1');
    expect(result.report.trustNarrative).toContain('paused-and-notified');
    expect(result.report.trustNarrative).toContain('never auto-confirmed');
  });

  it('omits schedule narration when there is no schedule.json sidecar', async () => {
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        runId: 'plain-run',
        workflowName: 'demo',
        status: 'completed',
        startedAt: '2026-07-05T08:00:00.000Z',
      }),
      'utf8',
    );
    const result = await buildAuditReport('plain-run', runDir);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.trustNarrative).not.toContain('Fired by schedule');
  });

  it('handles missing optional files gracefully', async () => {
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({ workflowName: 'wf', status: 'running' }),
      'utf8',
    );

    const result = await buildAuditReport('test-run', runDir);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.llmCallCount).toBe(0);
    expect(result.report.secretLookups).toHaveLength(0);
    expect(result.report.stepCount).toBe(0);
  });

  it('skips corrupt JSONL lines rather than throwing', async () => {
    await writeFile(join(runDir, 'manifest.json'), '{"status":"completed"}', 'utf8');
    await writeFile(
      join(runDir, 'agent.jsonl'),
      'not valid json\n{"direction":"response"}\n',
      'utf8',
    );

    const result = await buildAuditReport('test-run', runDir);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.llmCallCount).toBe(1);
  });

  it('never surfaces a credential-shaped secret value', async () => {
    await writeFile(join(runDir, 'manifest.json'), '{"status":"completed"}', 'utf8');
    // secrets.jsonl entries carry KEYS only, never values — verify the audit
    // builder respects this invariant even when keys themselves are odd shapes.
    await writeFile(
      join(runDir, 'secrets.jsonl'),
      `${JSON.stringify({ key: 'sk-test-FAKE-credential', step_id: 's1', ts: 'ts' })}\n`,
      'utf8',
    );

    const result = await buildAuditReport('test-run', runDir);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.secretLookups[0]?.key).toBe('sk-test-FAKE-credential');
    // No value field ever exists on a secret lookup record.
    expect(result.report.secretLookups[0]).not.toHaveProperty('value');
  });

  it('renders ordered agent tool calls, incomplete calls, confirmations, metadata, and usage', async () => {
    const hash = 'a'.repeat(64);
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        runId: 'agent-run',
        workflowName: 'ask',
        status: 'completed',
        startedAt: '2026-07-14T12:00:00.000Z',
        endedAt: '2026-07-14T12:00:03.000Z',
        durationMs: 3000,
        agent: {
          adapter: 'pi-coding-agent',
          sdk_version: '0.80.6',
          provider: 'anthropic',
          model: 'claude-sonnet',
          thinking: 'medium',
          auth_source: 'environment',
          session_id: 'session-1',
          session_file: 'agent/session-1.jsonl',
          prompt_version: 'agent-v1',
          prompt_hash: hash,
          tool_catalog_hash: hash,
        },
      }),
      'utf8',
    );
    const base = {
      run_id: 'agent-run',
      session_id: 'session-1',
      input_sanitized: null,
      output_sanitized: null,
      status: null,
      duration_ms: null,
      error_code: null,
      confirmation_id: null,
    };
    const toolLines = [
      {
        ...base,
        ts: '2026-07-14T12:00:00.000Z',
        seq: 0,
        call_id: 'a',
        tool: 'web_search',
        phase: 'start',
        input_sanitized: { query: 'safe' },
      },
      {
        ...base,
        ts: '2026-07-14T12:00:00.100Z',
        seq: 1,
        call_id: 'a',
        tool: 'web_search',
        phase: 'end',
        output_sanitized: { results: [] },
        status: 'ok',
        duration_ms: 100,
      },
      {
        ...base,
        ts: '2026-07-14T12:00:01.000Z',
        seq: 2,
        call_id: 'b',
        tool: 'browser_click',
        phase: 'start',
        input_sanitized: { ref: 'e1' },
      },
      {
        ...base,
        ts: '2026-07-14T12:00:01.010Z',
        seq: 3,
        call_id: 'b',
        tool: 'browser_click',
        phase: 'end',
        output_sanitized: { status: 'denied' },
        status: 'denied',
        duration_ms: 10,
        error_code: 'CONFIRMATION_DENIED',
        confirmation_id: 'confirm-1',
      },
      {
        ...base,
        ts: '2026-07-14T12:00:02.000Z',
        seq: 4,
        call_id: 'c',
        tool: 'web_fetch',
        phase: 'start',
        input_sanitized: { url: 'https://example.test' },
      },
    ];
    await writeFile(
      join(runDir, 'tool-calls.jsonl'),
      `${toolLines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      join(runDir, 'confirmations.jsonl'),
      `${JSON.stringify({ confirmation_id: 'confirm-1', decision: 'denied' })}\n`,
      'utf8',
    );
    await writeFile(
      join(runDir, 'usage.json'),
      JSON.stringify({
        run_id: 'agent-run',
        calls: [],
        totals: { input_tokens: 0, output_tokens: 0, cost_estimate_usd: 0, call_count: 0 },
        agent: { turns: 2, input_tokens: 20, output_tokens: 8, cost_usd: 0.04 },
      }),
      'utf8',
    );

    const result = await buildAuditReport('agent-run', runDir);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.agent).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet',
      promptVersion: 'agent-v1',
      sessionFile: 'agent/session-1.jsonl',
    });
    expect(result.report.workflowName).toBe('ask');
    expect(result.report.toolCalls.map(({ tool }) => tool)).toEqual([
      'web_search',
      'browser_click',
      'web_fetch',
    ]);
    expect(result.report.toolCalls[1]).toMatchObject({
      status: 'denied',
      confirmationId: 'confirm-1',
      confirmationDecision: 'denied',
    });
    expect(result.report.toolCalls[2]).toMatchObject({ status: 'incomplete', incomplete: true });
    expect(result.report.usage).toEqual({
      turns: 2,
      inputTokens: 20,
      outputTokens: 8,
      costUsd: 0.04,
    });
  });

  it('renders typed startup failures from the manifest', async () => {
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        workflowName: 'do',
        status: 'failed',
        agent: { provider: 'anthropic' },
        agentError: {
          code: 'AGENT_AUTH_UNAVAILABLE',
          message: 'No credential source is configured.',
        },
      }),
      'utf8',
    );

    const result = await buildAuditReport('failed-run', runDir);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.terminalError).toEqual({
      code: 'AGENT_AUTH_UNAVAILABLE',
      message: 'No credential source is configured.',
    });
  });

  it('uses only stable projections and never reads provider or legacy agent JSONL', async () => {
    const hash = 'b'.repeat(64);
    await mkdir(join(runDir, 'agent'));
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        status: 'completed',
        agent: {
          adapter: 'pi-coding-agent',
          sdk_version: '0.80.6',
          provider: 'anthropic',
          model: 'claude-sonnet',
          thinking: 'off',
          auth_source: 'managed',
          session_id: 'session-raw',
          session_file: 'agent/session-raw.jsonl',
          prompt_version: 'agent-v1',
          prompt_hash: hash,
          tool_catalog_hash: hash,
        },
      }),
      'utf8',
    );
    await writeFile(join(runDir, 'agent', 'session-raw.jsonl'), 'sk-raw-provider-secret', 'utf8');
    await writeFile(
      join(runDir, 'agent.jsonl'),
      '{"direction":"response","secret":"sk-legacy-secret"}\n',
      'utf8',
    );

    const result = await buildAuditReport('stable-only', runDir);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.report.llmCallCount).toBe(0);
    expect(JSON.stringify(result.report)).not.toContain('sk-raw-provider-secret');
    expect(JSON.stringify(result.report)).not.toContain('sk-legacy-secret');
    expect(result.report.agent?.sessionFile).toBe('agent/session-raw.jsonl');
  });
});
