import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MarkdownReportBuilder } from '../../src/audit/report-builder.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, '__fixtures__/sample-run');

describe('@no-llm report builder', () => {
  it('renders all required sections from run artifacts', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-builder-'));

    await copyFile(join(fixtureRoot, 'manifest.json'), join(runDir, 'manifest.json'));
    await copyFile(join(fixtureRoot, 'events.jsonl'), join(runDir, 'events.jsonl'));
    await copyFile(join(fixtureRoot, 'agent.jsonl'), join(runDir, 'agent.jsonl'));
    await copyFile(join(fixtureRoot, 'secrets.jsonl'), join(runDir, 'secrets.jsonl'));

    const builder = new MarkdownReportBuilder();
    const markdown = await builder.build(runDir, 'completed');

    expect(markdown).toContain('# Run');
    expect(markdown).toContain('## Steps Timeline');
    expect(markdown).toContain('## Failure (if any)');
    expect(markdown).toContain('## Locator Fallback');
    expect(markdown).toContain('## Sanitizer');
    expect(markdown).toContain('## Secrets Resolved');
    expect(markdown).toContain('## Audit Trail');

    const savedReport = await readFile(join(runDir, 'report.md'), 'utf8');
    expect(savedReport).toBe(markdown);

    await rm(runDir, { recursive: true, force: true });
  });

  it('includes explicit failure details when provided', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-builder-failure-'));

    await writeFile(join(runDir, 'events.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'agent.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'secrets.jsonl'), '', 'utf8');

    const builder = new MarkdownReportBuilder();
    const markdown = await builder.build(runDir, 'failed', {
      failureClass: 'scope_violation',
      message: 'Mutating step in read-only scope',
    });

    expect(markdown).toContain('Failure class: scope_violation');
    expect(markdown).toContain('Cause: Mutating step in read-only scope');

    await rm(runDir, { recursive: true, force: true });
  });

  it('renders agent usage totals including partial spend', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-builder-usage-'));
    await writeFile(join(runDir, 'events.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'agent.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'secrets.jsonl'), '', 'utf8');
    await writeFile(
      join(runDir, 'usage.json'),
      JSON.stringify({
        run_id: 'usage-run',
        calls: [],
        totals: {
          input_tokens: 0,
          output_tokens: 0,
          cost_estimate_usd: 0,
          call_count: 0,
        },
        agent: { turns: 2, input_tokens: 17, output_tokens: 7, cost_usd: 0.03 },
      }),
      'utf8',
    );

    const markdown = await new MarkdownReportBuilder().build(runDir, 'failed');
    expect(markdown).toContain('## Agent Usage');
    expect(markdown).toContain('Turns: 2');
    expect(markdown).toContain('Input tokens: 17');
    expect(markdown).toContain('Cost (USD): 0.03');

    await rm(runDir, { recursive: true, force: true });
  });
});

describe('@no-llm report builder — agentic runs', () => {
  const AGENT_SECTION = {
    adapter: 'pi-coding-agent',
    sdk_version: '0.80.6',
    provider: 'ollama',
    model: 'gemma4:e4b',
    thinking: 'off',
    auth_source: 'managed',
    session_id: 'session-1',
    session_file: 'agent/session-1.jsonl',
    prompt_version: 'agent-v1',
    prompt_hash: 'hash',
    tool_catalog_hash: 'hash',
  };

  function toolCallLine(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      ts: '2026-07-16T23:39:55.777Z',
      seq: 0,
      run_id: 'agentic-run',
      session_id: 'session-1',
      call_id: 'c1',
      tool: 'web_search',
      phase: 'start',
      input_sanitized: null,
      output_sanitized: null,
      status: null,
      duration_ms: null,
      error_code: null,
      confirmation_id: null,
      ...overrides,
    });
  }

  async function writeAgenticRun(runDir: string, toolCallLines: readonly string[]): Promise<void> {
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({ runId: 'agentic-run', runKind: 'agentic', agent: AGENT_SECTION }),
      'utf8',
    );
    await writeFile(
      join(runDir, 'events.jsonl'),
      `${JSON.stringify({ task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', at: '2026-07-16T23:38:40.099Z', kind: 'task_started' })}\n`,
      'utf8',
    );
    await writeFile(join(runDir, 'tool-calls.jsonl'), `${toolCallLines.join('\n')}\n`, 'utf8');
    await writeFile(join(runDir, 'secrets.jsonl'), '', 'utf8');
    await writeFile(
      join(runDir, 'usage.json'),
      JSON.stringify({
        run_id: 'agentic-run',
        calls: [],
        totals: { input_tokens: 0, output_tokens: 0, cost_estimate_usd: 0, call_count: 0 },
        agent: { turns: 4, input_tokens: 8246, output_tokens: 1190, cost_usd: 0 },
      }),
      'utf8',
    );
  }

  it('renders session metadata and the tool-call timeline from tool-calls.jsonl', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-agentic-'));
    await writeAgenticRun(runDir, [
      toolCallLine({ seq: 0, call_id: 'c1', tool: 'web_search', phase: 'start' }),
      toolCallLine({
        seq: 1,
        call_id: 'c1',
        tool: 'web_search',
        phase: 'end',
        status: 'ok',
        duration_ms: 1898,
      }),
      toolCallLine({ seq: 2, call_id: 'c2', tool: 'web_fetch', phase: 'start' }),
      toolCallLine({
        seq: 3,
        call_id: 'c2',
        tool: 'web_fetch',
        phase: 'end',
        status: 'error',
        duration_ms: 12,
        error_code: 'FETCH_BLOCKED',
      }),
    ]);

    const markdown = await new MarkdownReportBuilder().build(runDir, 'failed', {
      failureClass: 'AGENT_COMPLETION_MISSING',
      message: 'No publication. Final agent message: the goal was truncated.',
    });

    expect(markdown).toContain('## Agent Session');
    expect(markdown).toContain('Provider: ollama');
    expect(markdown).toContain('Model: gemma4:e4b');
    expect(markdown).toContain('## Tool Calls');
    expect(markdown).toContain('- [0] web_search - ok - 1898ms');
    expect(markdown).toContain('- [2] web_fetch - error (FETCH_BLOCKED) - 12ms');
    expect(markdown).toContain('Failure class: AGENT_COMPLETION_MISSING');
    expect(markdown).toContain('Final agent message: the goal was truncated.');
    expect(markdown).toContain('Turns: 4');
    // Agentic audit trail lists what agentic runs actually write.
    expect(markdown).toContain('- tool-calls.jsonl');
    expect(markdown).toContain('- agent/session-1.jsonl');
    expect(markdown).not.toContain('- agent.jsonl');
    expect(markdown).not.toContain('## Steps Timeline');

    await rm(runDir, { recursive: true, force: true });
  });

  it('marks a start without a matching end as incomplete', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-agentic-incomplete-'));
    await writeAgenticRun(runDir, [
      toolCallLine({ seq: 0, call_id: 'c1', tool: 'browser_navigate', phase: 'start' }),
    ]);

    const markdown = await new MarkdownReportBuilder().build(runDir, 'failed', {
      failureClass: 'AGENT_ABORTED',
      message: 'Interrupted.',
    });

    expect(markdown).toContain('- [0] browser_navigate - incomplete');

    await rm(runDir, { recursive: true, force: true });
  });

  it('renders "- none" tool calls for an agentic run that never called a tool', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-agentic-empty-'));
    await writeAgenticRun(runDir, []);

    const markdown = await new MarkdownReportBuilder().build(runDir, 'failed', {
      failureClass: 'AGENT_SESSION_START_FAILED',
      message: 'Startup failed.',
    });

    expect(markdown).toContain('## Tool Calls');
    expect(markdown).toContain('- none');

    await rm(runDir, { recursive: true, force: true });
  });
});
