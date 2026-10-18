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

  it('renders a partially-successful call distinctly instead of a flat ok', async () => {
    // A batch that applied two fields and failed two succeeded as a *call*, so
    // the middleware records status "ok". Rendering it that way here hides the
    // shape this projection exists to make readable — the investigation behind
    // this feature was conducted by reading these very lines.
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-agentic-partial-'));
    await writeAgenticRun(runDir, [
      toolCallLine({ seq: 0, call_id: 'p1', tool: 'browser_fill_form', phase: 'start' }),
      toolCallLine({
        seq: 1,
        call_id: 'p1',
        tool: 'browser_fill_form',
        phase: 'end',
        status: 'ok',
        duration_ms: 4200,
        output_sanitized: {
          status: 'ok',
          details: { partial: true, applied_count: 2, failed_count: 1, skipped_count: 1 },
        },
      }),
      toolCallLine({ seq: 2, call_id: 'p2', tool: 'browser_fill_form', phase: 'start' }),
      toolCallLine({
        seq: 3,
        call_id: 'p2',
        tool: 'browser_fill_form',
        phase: 'end',
        status: 'ok',
        duration_ms: 900,
        output_sanitized: {
          status: 'ok',
          details: { partial: false, applied_count: 3, failed_count: 0, skipped_count: 0 },
        },
      }),
    ]);

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).toContain(
      '- [0] browser_fill_form - partial (2 applied, 1 failed, 1 skipped) - 4200ms',
    );
    // A batch where everything landed still reads as an ordinary success.
    expect(markdown).toContain('- [2] browser_fill_form - ok - 900ms');

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

  it('lists runtime.jsonl in the audit trail when the run wrote one', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-agentic-runtime-'));
    await writeAgenticRun(runDir, []);
    await writeFile(
      join(runDir, 'runtime.jsonl'),
      `${JSON.stringify({ run_id: 'agentic-run', event: 'browser_ready' })}\n`,
      'utf8',
    );

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).toContain('## Audit Trail');
    expect(markdown).toContain('- runtime.jsonl');

    await rm(runDir, { recursive: true, force: true });
  });

  it('omits runtime.jsonl from a pre-feature run directory that has none', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-agentic-no-runtime-'));
    await writeAgenticRun(runDir, []);

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    // Backward compatibility: a run directory written before this artifact
    // existed renders exactly as it always did.
    expect(markdown).toContain('## Audit Trail');
    expect(markdown).not.toContain('runtime.jsonl');
    expect(markdown).toContain('- tool-calls.jsonl');

    await rm(runDir, { recursive: true, force: true });
  });

  it('never reads the runtime log or lets it change the rendered outcome', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-agentic-opaque-'));
    await writeAgenticRun(runDir, []);
    // Deliberately unparseable, and claiming a failure the run did not have.
    await writeFile(
      join(runDir, 'runtime.jsonl'),
      'not json at all\n{"event":"browser_startup_failed"}\n',
      'utf8',
    );

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).toContain('Outcome: completed');
    expect(markdown).toContain('Failure class: none');
    expect(markdown).toContain('- runtime.jsonl');
    expect(markdown).not.toContain('browser_startup_failed');

    await rm(runDir, { recursive: true, force: true });
  });

  const RUN_HEALTH = {
    schema_version: 1,
    run_id: 'agentic-run',
    searches: {
      total: 22,
      ok: 11,
      failed_by_code: { SEARCH_NO_RESULTS: 2, SEARCH_BLOCKED: 9 },
      providers: ['duckduckgo'],
    },
    fetches: {
      total: 26,
      by_mode: { http: 20, browser: 6 },
      repeat_fetches: 9,
      failed_by_code: { FETCH_TIMEOUT: 1 },
    },
    source_failures: { fetch: 4, extract: 1, blocked: 0, budget: 2, policy: 0 },
    browser: { launches: 3 },
    budgets: {
      navigations_used: 30,
      navigations_limit: 30,
      hosts_used: 12,
      hosts_limit: 20,
      exhausted: ['navigations'],
    },
    tool_failures: {
      total: 12,
      by_code: { FETCH_TIMEOUT: 1, SEARCH_BLOCKED: 9, SEARCH_NO_RESULTS: 2 },
    },
    notices: 5,
  };

  it('renders Run Health after Tool Calls and lists run-health.json in the audit trail', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-run-health-'));
    await writeAgenticRun(runDir, []);
    await writeFile(join(runDir, 'run-health.json'), JSON.stringify(RUN_HEALTH), 'utf8');

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    const section = [
      '## Run Health',
      'Searches: 22 total, 11 ok, 11 failed (SEARCH_BLOCKED 9, SEARCH_NO_RESULTS 2) - providers: duckduckgo',
      'Fetches: 26 total (20 http, 6 browser), 9 repeat - failed: FETCH_TIMEOUT 1',
      'Source failures: fetch 4, extract 1, blocked 0, budget 2, policy 0',
      'Browser launches: 3',
      'Navigations: 30/30   Hosts: 12/20   Exhausted: navigations',
      'Tool failures: 12 (SEARCH_BLOCKED 9, SEARCH_NO_RESULTS 2, FETCH_TIMEOUT 1)',
      'Notices: 5',
      '',
      '## Captures',
    ].join('\n');
    expect(markdown).toContain(section);
    expect(markdown.indexOf('## Tool Calls')).toBeLessThan(markdown.indexOf('## Run Health'));
    expect(markdown).toContain('- run-health.json');

    await rm(runDir, { recursive: true, force: true });
  });

  it('renders the FEAT-051 extraction line with counts only', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-extraction-'));
    await writeAgenticRun(runDir, []);
    const health = {
      ...RUN_HEALTH,
      extraction: {
        pages_by_shape: { collection: 1, article: 2, detail: 0 },
        records_shown: 6,
        links_offered: 14,
        links_withheld: 1,
        discovered_follows: 3,
      },
    };
    await writeFile(join(runDir, 'run-health.json'), JSON.stringify(health), 'utf8');

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).toContain(
      'Notices: 5\nExtraction: pages article 2, collection 1 - records shown 6 - links offered 14, withheld 1, followed 3\n',
    );
    const line = markdown.split('\n').find((entry) => entry.startsWith('Extraction:')) ?? '';
    expect(line).not.toMatch(/https?:|\/\//u);

    await rm(runDir, { recursive: true, force: true });
  });

  it('says which captures the model saw, for new artifacts and legacy captures (FEAT-058)', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-captures-'));
    const sha = 'e'.repeat(64);
    await writeAgenticRun(runDir, [
      toolCallLine({
        seq: 1,
        tool: 'browser_screenshot',
        phase: 'end',
        status: 'ok',
        captures: [
          {
            path: 'screenshots/1-eeeeeeeeeeee.png',
            sha256: sha,
            mime_type: 'image/png',
            width: 800,
            height: 600,
            bytes: 500,
          },
        ],
      }),
      toolCallLine({
        seq: 2,
        call_id: 'c2',
        tool: 'browser_capture',
        phase: 'end',
        status: 'ok',
        artifacts: [
          {
            kind: 'screenshot',
            path: 'screenshots/capture-1-eeeeeeeeeeee.png',
            sha256: sha,
            mime_type: 'image/png',
            bytes: 700,
            width: 1280,
            height: 720,
            sent_to_model: false,
          },
        ],
      }),
    ]);

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).toContain(
      `- [1] screenshots/1-eeeeeeeeeeee.png - 800x600, 500 bytes, image/png, sha256=${sha}, sent to model: yes\n`,
    );
    expect(markdown).toContain(
      `- [2] screenshots/capture-1-eeeeeeeeeeee.png - 1280x720, 700 bytes, image/png, sha256=${sha}, sent to model: no\n`,
    );

    await rm(runDir, { recursive: true, force: true });
  });

  it('renders an old run without run-health.json byte-identically to before', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-no-run-health-'));
    await writeAgenticRun(runDir, []);

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).not.toContain('Run Health');
    expect(markdown).not.toContain('run-health.json');
    expect(markdown).toContain('- none\n\n## Captures');

    await rm(runDir, { recursive: true, force: true });
  });

  it('renders one unreadable line for an invalid run-health.json and never throws', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-bad-run-health-'));
    await writeAgenticRun(runDir, []);
    await writeFile(
      join(runDir, 'run-health.json'),
      JSON.stringify({ ...RUN_HEALTH, searches: { ...RUN_HEALTH.searches, total: 3 } }),
      'utf8',
    );

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).toContain('Run Health: run-health.json unreadable');
    expect(markdown).not.toContain('## Run Health');
    expect(markdown).toContain('- run-health.json');

    await rm(runDir, { recursive: true, force: true });
  });

  it('treats unparseable run-health.json as unreadable', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-garbage-run-health-'));
    await writeAgenticRun(runDir, []);
    await writeFile(join(runDir, 'run-health.json'), 'not json', 'utf8');

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).toContain('Run Health: run-health.json unreadable');

    await rm(runDir, { recursive: true, force: true });
  });

  const CONTRACT = {
    schema_version: 1,
    run_id: 'agentic-run',
    command: 'research',
    revisions: [
      {
        revision: 1,
        declared_at: '2026-10-12T12:00:00.000Z',
        contract: {
          deliverable: 'table',
          subject: 'new SUV listings',
          required_fields: ['dealer', 'price'],
          filters: [{ name: 'drivetrain', value: 'AWD' }],
          required_sources: ['example-listings.test'],
          ranking: null,
          limit: null,
          notes: null,
        },
      },
      {
        revision: 2,
        declared_at: '2026-10-12T12:00:09.000Z',
        contract: {
          deliverable: 'table',
          subject: 'new SUV listings',
          required_fields: ['dealer', 'price', 'color'],
          filters: [
            { name: 'drivetrain', value: 'AWD' },
            { name: 'condition', value: 'new' },
          ],
          required_sources: ['example-listings.test'],
          ranking: { field: 'price', direction: 'asc' },
          limit: 10,
          notes: 'dealer listings only',
        },
      },
    ],
  };

  it('renders the current Task Contract and its revision count (FEAT-052)', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-contract-'));
    await writeAgenticRun(runDir, []);
    await writeFile(join(runDir, 'contract.json'), JSON.stringify(CONTRACT), 'utf8');

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).toContain(
      [
        '## Task Contract',
        'Deliverable: table - new SUV listings',
        'Required fields: dealer, price, color',
        'Filters: drivetrain=AWD, condition=new',
        'Required sources: example-listings.test',
        'Ranking: price asc',
        'Limit: 10',
        'Notes: dealer listings only',
        'Revisions: 2',
        '',
      ].join('\n'),
    );
    expect(markdown.indexOf('## Tool Calls')).toBeLessThan(markdown.indexOf('## Task Contract'));
    expect(markdown).toContain('- contract.json');

    await rm(runDir, { recursive: true, force: true });
  });

  it('renders one line for an invalid contract.json and never throws', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-bad-contract-'));
    await writeAgenticRun(runDir, []);
    await writeFile(
      join(runDir, 'contract.json'),
      JSON.stringify({ ...CONTRACT, revisions: [] }),
      'utf8',
    );

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).toContain('Task Contract: contract.json present but invalid');
    expect(markdown).not.toContain('## Task Contract');

    await writeFile(join(runDir, 'contract.json'), 'not json', 'utf8');
    const garbage = await new MarkdownReportBuilder().build(runDir, 'completed');
    expect(garbage).toContain('Task Contract: contract.json present but invalid');

    await rm(runDir, { recursive: true, force: true });
  });

  it('renders no Task Contract section when the run declared none', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-report-no-contract-'));
    await writeAgenticRun(runDir, []);

    const markdown = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(markdown).not.toContain('Task Contract');
    expect(markdown).not.toContain('contract.json');

    await rm(runDir, { recursive: true, force: true });
  });
});
