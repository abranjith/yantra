// @no-llm
/**
 * Runs without a document (FEAT-066 TASK-007): a zero-synthesis workflow, a
 * pre-Brief failure, an interrupted legacy run, a legacy run with only a
 * manifest and report, an unverifiable owner, and an oversized report. Each
 * page is complete: every region shows a value or an explicit "not recorded".
 */

import { screen, waitFor, within } from '@testing-library/react';
import type { ReportResult, RunHealth } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INTERRUPTED_TEXT } from '../../../src/features/run-result/NoDocumentResult.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { RUN_ID, runView } from '../../support/briefs.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import {
  installIntersectionObserver,
  resetIntersectionObservers,
} from '../../support/intersection-observer.js';
import { useFixedLayout } from '../../support/layout.js';

useFixedLayout(1200, 800);

beforeEach(() => {
  installIntersectionObserver();
});

afterEach(() => {
  resetIntersectionObservers();
});

const HEALTH: RunHealth = {
  schema_version: 1,
  run_id: RUN_ID,
  searches: {
    total: 3,
    ok: 2,
    failed_by_code: { SEARCH_NO_RESULTS: 1 },
    providers: ['duckduckgo'],
  },
  fetches: { total: 4, by_mode: { http: 3, browser: 1 }, repeat_fetches: 0, failed_by_code: {} },
  source_failures: { fetch: 0, extract: 0, blocked: 0, budget: 0, policy: 0 },
  browser: { launches: 1 },
  budgets: {
    navigations_used: 4,
    navigations_limit: 30,
    hosts_used: 2,
    hosts_limit: 20,
    exhausted: [],
  },
  tool_failures: { total: 1, by_code: { SEARCH_NO_RESULTS: 1 } },
  notices: 2,
};

const FILES = [
  {
    path: 'manifest.json',
    entry_id: 'manifest.json',
    exposure: 'view',
    viewer: 'json',
    bytes: 400,
    modified_at: '2026-11-01T00:01:00.000Z',
    over_inline_cap: false,
  },
  {
    path: 'report.md',
    entry_id: 'report.md',
    exposure: 'view',
    viewer: 'markdown',
    bytes: 120,
    modified_at: '2026-11-01T00:01:00.000Z',
    over_inline_cap: false,
  },
];

function report(markdown: string, extra: Partial<ReportResult> = {}): ReportResult {
  return { schemaVersion: '0.2', kind: 'report', markdown, ...extra };
}

async function open(
  overrides: Record<string, unknown>,
  reportResult: ReportResult | null = report('# Report\n\nAll steps ran.\n'),
) {
  const view = runView({
    document: { kind: 'none' },
    notices_source: 'none',
    artifacts: FILES,
    ...overrides,
  });
  const rpc = new FakeRpc().answer('read.run_result', view).answer('read.report', () => {
    if (reportResult === null) throw new Error('report.md not found');
    return reportResult;
  });
  const rendered = await renderAt(`/runs/${RUN_ID}`, rpc);
  await screen.findByRole('tablist', { name: 'Run views' });
  return { ...rendered, rpc, view };
}

/** Every region has content beyond its heading; nothing failed to render. */
function expectComplete(): void {
  const regions = document.querySelectorAll('[data-document="none"] [data-region]');
  expect(regions.length).toBeGreaterThanOrEqual(6);
  for (const region of regions) {
    const heading = region.querySelector('h2')?.textContent ?? '';
    const body = (region.textContent ?? '').slice(heading.length).trim();
    expect({ region: region.getAttribute('data-region'), empty: body.length === 0 }).toEqual({
      region: region.getAttribute('data-region'),
      empty: false,
    });
  }
}

function region(id: string): HTMLElement {
  return document.querySelector(`[data-region="${id}"]`)!;
}

describe('runs without a document', () => {
  it('a successful zero-synthesis workflow: outputs, fulfilled, report and files', async () => {
    await open({
      mode: 'run',
      title: 'bank-statement',
      task_outcome: 'fulfilled',
      outputs: {
        state: 'ok',
        path: 'outputs.json',
        value: { balance: '1,024.00', statements: ['jan.pdf'] },
      },
    });

    expect(within(region('outcome')).getByText('completed fulfilled')).toBeTruthy();
    const outputs = within(region('outputs')).getByRole('group', { name: 'Workflow outputs' });
    expect(within(outputs).getByText('"1,024.00"')).toBeTruthy();
    await waitFor(() => {
      expect(within(region('report')).getByText('All steps ran.')).toBeTruthy();
    });
    expect(within(region('artifacts')).getByText('report.md')).toBeTruthy();
    expectComplete();
  });

  it('a pre-Brief failure shows the startup code and message and no empty section', async () => {
    await open({
      status: 'failed',
      task_outcome: 'failed',
      termination_reason: null,
      terminal: {
        source: 'manifest',
        failure_class: 'AGENT_AUTH_UNAVAILABLE',
        message: 'No credentials for anthropic. Run `yantra model auth`.',
      },
    });

    const terminal = region('terminal');
    expect(within(terminal).getByText('AGENT_AUTH_UNAVAILABLE')).toBeTruthy();
    expect(
      within(terminal).getByText('No credentials for anthropic. Run `yantra model auth`.'),
    ).toBeTruthy();
    expect(within(terminal).getByText('Recorded in manifest.json')).toBeTruthy();
    expectComplete();
  });

  it('an interrupted legacy run reads as interrupted with its evidence-based outcome', async () => {
    await open({
      status: 'failed',
      task_outcome: 'failed',
      termination_reason: 'owner_lost',
      execution_state: 'interrupted',
      terminal: { source: 'manifest', termination_reason: 'owner_lost' },
    });

    const outcome = region('outcome');
    expect(within(outcome).getByText('interrupted')).toBeTruthy();
    expect(outcome.querySelector('[data-part="interrupted"]')?.textContent).toBe(
      `${INTERRUPTED_TEXT} The outcome follows the evidence it left: failed.`,
    );
    expect(within(outcome).getByText('owner_lost')).toBeTruthy();
    await waitFor(() => {
      expect(within(region('report')).getByText('All steps ran.')).toBeTruthy();
    });
    expectComplete();
  });

  it('a legacy run with only manifest.json and report.md is complete', async () => {
    await open({
      mode: 'run',
      task_outcome: null,
      termination_reason: null,
      terminal: null,
      outputs: { state: 'missing', path: 'outputs.json' },
    });

    expect(
      within(region('terminal')).getByText('No reason was recorded for how this run ended.'),
    ).toBeTruthy();
    expect(
      within(region('run-health')).getByText('No run health was recorded for this run.'),
    ).toBeTruthy();
    expect(within(region('notices')).getByText('No notices recorded.')).toBeTruthy();
    expect(within(region('outputs')).getByText('No outputs recorded for this run.')).toBeTruthy();
    expectComplete();
  });

  it('shows run health with the report.md labels and the notice count', async () => {
    await open({
      run_health: { state: 'ok', path: 'run-health.json', value: HEALTH },
      notices_source: 'run_health',
    });

    expect(within(region('run-health')).getByText('Browser launches: 1')).toBeTruthy();
    expect(
      within(region('run-health')).getByText(
        'Searches: 3 total, 2 ok, 1 failed (SEARCH_NO_RESULTS 1) - providers: duckduckgo',
      ),
    ).toBeTruthy();
    expect(within(region('notices')).getByText(/2 notices were recorded/u)).toBeTruthy();
  });

  it('says the status is unknown for a running run whose owner cannot be verified', async () => {
    await open({ status: 'running', task_outcome: null, live: { state: 'unknown_owner' } });
    expect(
      screen.getByText('Status unknown — the owner of this run can’t be verified.'),
    ).toBeTruthy();
    expect(screen.queryByText('running', { selector: '[data-part="text"]' })).toBeNull();
  });

  it('truncates a 700 KiB report with a banner and Show in folder', async () => {
    await open(
      { report: { exists: true, bytes: 716_800 } },
      report('# Report\n\nHead of a long report.\n', { truncated: true, bytes: 716_800 }),
    );

    const banner = await within(region('report')).findByRole('note');
    expect(banner.textContent).toContain('the whole file is 700.0 KiB');
    expect(within(banner).getByText(`yantra open ${RUN_ID} --artifact dir`)).toBeTruthy();
    expect(within(region('report')).getByText('Head of a long report.')).toBeTruthy();
  });

  it('never asks for report.md when the run has none', async () => {
    const { rpc } = await open({ report: { exists: false, bytes: null } }, null);
    expect(
      within(region('report')).getByText('No report.md was recorded for this run.'),
    ).toBeTruthy();
    expect(rpc.paramsOf('read.report')).toEqual([]);
    expectComplete();
  });

  it('shows the read error when report.md cannot be read', async () => {
    await open({}, null);
    expect(await within(region('report')).findByText('report.md not found')).toBeTruthy();
  });

  it('has no axe violations', async () => {
    const { container } = await open({
      outputs: { state: 'ok', path: 'outputs.json', value: { a: 1 } },
      run_health: { state: 'ok', path: 'run-health.json', value: HEALTH },
      terminal: { source: 'events', failure_class: 'navigation_timeout' },
    });
    await waitFor(() => {
      expect(within(region('report')).getByText('All steps ran.')).toBeTruthy();
    });
    await expectNoAxeViolations(container);
  });
});
