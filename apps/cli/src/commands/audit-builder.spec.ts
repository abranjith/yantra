import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});
