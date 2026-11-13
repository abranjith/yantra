// @no-llm
/**
 * Run result route (FEAT-066 TASK-005): every golden Brief and every Brief
 * variant renders completely and safely; templated documents; slot states
 * with their recovery links; header, tabs, files and axe.
 */

import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { editorialMarkIsInformative as protocolEditorial, type Brief } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { editorialMarkIsInformative } from '../../src/features/run-result/BriefDocument.js';
import { browserNav } from '../../src/host/browser-nav.js';
import { RpcCallError } from '../../src/host/rpc-client.js';
import { expectNoAxeViolations } from '../support/axe.js';
import {
  RUN_ID,
  brief,
  briefVariants,
  briefView,
  goldenBriefs,
  runView,
  templatedReport,
} from '../support/briefs.js';
import { FakeRpc, renderAt } from '../support/fake-rpc.js';
import {
  installIntersectionObserver,
  resetIntersectionObservers,
} from '../support/intersection-observer.js';
import { useFixedLayout } from '../support/layout.js';

useFixedLayout(1200, 800);

beforeEach(() => {
  installIntersectionObserver();
});

afterEach(() => {
  resetIntersectionObservers();
});

function rpcFor(view: ReturnType<typeof runView>): FakeRpc {
  return new FakeRpc().answer('read.run_result', view).answer('artifact.url', (params) => ({
    url: `/a/${String(params.path)}.mac`,
    expires_at: '2026-11-01T00:05:00.000Z',
  }));
}

async function open(view: ReturnType<typeof runView>) {
  const rpc = rpcFor(view);
  const rendered = await renderAt(`/runs/${view.run_id}`, rpc);
  await screen.findByRole('tablist', { name: 'Run views' });
  return { ...rendered, rpc };
}

/** Text with citation tokens and action ids removed, whitespace collapsed. */
function plain(text: string): string {
  return text
    .replace(/\[A?\d+\]/gu, ' ')
    .replace(/\bA\d+\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function expectComplete(container: HTMLElement, value: Brief): void {
  const article = container.querySelector('[data-document="brief"]');
  expect(article).not.toBeNull();
  const text = plain(article!.textContent ?? '');
  for (const finding of value.key_findings) {
    expect(text).toContain(plain(finding.text));
    for (const child of finding.children) expect(text).toContain(plain(child.text));
  }
  for (const item of value.sources) {
    expect(container.querySelectorAll(`[data-source="${String(item.n)}"]`)).toHaveLength(1);
  }
  const consulted = container.querySelector('section[aria-labelledby="also-consulted"]');
  const consultedNumbers = [...(consulted?.querySelectorAll('[data-source]') ?? [])].map((node) =>
    Number(node.getAttribute('data-source')),
  );
  expect(consultedNumbers).toEqual(
    value.sources.filter((item) => item.cited === false).map((item) => item.n),
  );
}

describe('every golden Brief renders', () => {
  it.each(Object.entries(goldenBriefs()))('%s', async (_name, value) => {
    const { container } = await open(briefView(value));
    expectComplete(container, value);
  });
});

describe('every Brief variant renders', () => {
  it.each(Object.entries(briefVariants()))('%s', async (_name, value) => {
    const { container } = await open(briefView(value));
    expectComplete(container, value);
  });

  it('labels alternatives and renders the comparison with per-row chips', async () => {
    await open(briefView(briefVariants().alternatives!));
    expect(screen.getByText('alternatives')).toBeTruthy();
    const table = screen.getByRole('grid', { name: 'Comparison' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['City 2', 'Trail X']);
    expect(within(table).getByRole('button', { name: 'Source 2' })).toBeTruthy();
  });

  it('renders requirements, conditions and capture sets', async () => {
    await open(briefView(briefVariants().requirements!));
    expect(screen.getByText('Fill every eligible field')).toBeTruthy();
    expect(screen.getByText('+2 more')).toBeTruthy();

    await open(briefView(briefVariants().constraints!));
    expect(screen.getAllByRole('table', { name: 'Conditions' }).length).toBeGreaterThan(0);
    expect(screen.getByText('violated')).toBeTruthy();
  });

  it('loads capture thumbnails through signed URLs', async () => {
    const { rpc } = await open(briefView(briefVariants().artifacts!));
    await waitFor(() => {
      expect(rpc.paramsOf('artifact.url').map((params) => params.path)).toEqual([
        'screenshots/capture-1-aaaaaaaaaaaa-p1.png',
        'screenshots/capture-1-aaaaaaaaaaaa-p2.png',
      ]);
    });
    expect(screen.getByRole('heading', { name: 'Capture set 1 — 2 parts' })).toBeTruthy();
  });

  it('groups notices by kind with the words verbatim', async () => {
    await open(
      briefView(
        brief({
          notices: [
            { source: 'a.example', reason: 'Timed out', kind: 'fetch_failed' },
            { source: 'b.example', reason: 'Blocked', kind: 'blocked' },
            { source: 'c.example', reason: 'Timed out', kind: 'fetch_failed' },
          ],
        }),
      ),
    );
    const groups = document.querySelectorAll('[data-notice-kind]');
    expect([...groups].map((node) => node.getAttribute('data-notice-kind'))).toEqual([
      'fetch_failed',
      'blocked',
    ]);
    expect(groups[0]!.querySelectorAll('li')).toHaveLength(2);
  });

  it('shows the metadata footer', async () => {
    await open(briefView(brief()));
    const footer = screen.getByRole('contentinfo', { name: 'Document metadata' });
    expect(within(footer).getByText('llm')).toBeTruthy();
    expect(within(footer).getByText('80%')).toBeTruthy();
    expect(within(footer).getByText('4 checked, 1 flagged, 0 stripped')).toBeTruthy();
  });
});

describe('safety', () => {
  it('renders model text inert', async () => {
    const value = brief({
      overview:
        'Hi <script>window.__pwned = 1</script> <img src=x onerror="alert(1)"> [9] ![p](https://t.example/p.png)',
    });
    const { container } = await open(briefView(value));
    const article = container.querySelector('[data-document="brief"]')!;
    expect(article.querySelector('script, img')).toBeNull();
    expect(article.textContent).toContain('[9]');
  });
});

describe('the editorial mark', () => {
  it('appears only when the list mixes editorial and cited findings', async () => {
    const { container } = await open(briefView(briefVariants().mixedEditorial!));
    expect(container.querySelectorAll('[data-part="editorial"]')).toHaveLength(1);

    const again = await open(briefView(briefVariants().allEditorial!));
    expect(again.container.querySelectorAll('[data-part="editorial"]')).toHaveLength(0);
  });

  it('agrees with the protocol rule on every variant and golden Brief', () => {
    for (const value of [...Object.values(briefVariants()), ...Object.values(goldenBriefs())]) {
      expect(editorialMarkIsInformative(value.key_findings)).toBe(
        protocolEditorial(value.key_findings),
      );
    }
  });
});

describe('templated documents', () => {
  it('renders rendered_md and its Sources', async () => {
    const report = templatedReport();
    const { container } = await open(
      runView({
        title: report.title,
        document: {
          kind: 'templated_report',
          slot: { state: 'ok', path: 'document.json', value: report },
        },
        notices_source: 'document',
      }),
    );
    const article = container.querySelector('[data-document="templated_report"]')!;
    expect(
      within(article as HTMLElement).getByRole('heading', { name: 'Weekly Report' }),
    ).toBeTruthy();
    expect(within(article as HTMLElement).getByRole('button', { name: 'Source 1' })).toBeTruthy();
    expect(container.querySelectorAll('[data-source]')).toHaveLength(2);
    expect(screen.getByText('search_failed')).toBeTruthy();
  });
});

describe('slot states', () => {
  it('shows an older-format Brief with its version and both recovery links', async () => {
    await open(
      runView({
        document: {
          kind: 'brief',
          slot: { state: 'unsupported', path: 'brief.json', found_version: '0.1' },
        },
      }),
    );
    expect(screen.getByText(/older format \(0\.1\)/u)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open brief.md' }).getAttribute('href')).toBe(
      `/runs/${RUN_ID}/artifacts/brief.md`,
    );
    expect(screen.getByRole('button', { name: 'Download brief.html' })).toBeTruthy();
  });

  it('downloads brief.html through a fresh signed URL', async () => {
    const assign = vi.spyOn(browserNav, 'assign').mockImplementation(() => undefined);
    const { rpc } = await open(
      runView({
        document: {
          kind: 'brief',
          slot: { state: 'corrupt', path: 'brief.json', detail: 'not valid JSON' },
        },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Download brief.html' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/a/brief.html.mac');
    });
    expect(rpc.paramsOf('artifact.url')).toEqual([{ run_id: RUN_ID, path: 'brief.html' }]);
    assign.mockRestore();
  });

  it('offers no recovery link the run cannot serve', async () => {
    await open(
      runView({
        artifacts: [],
        document: {
          kind: 'brief',
          slot: { state: 'corrupt', path: 'brief.json', detail: 'not valid JSON' },
        },
      }),
    );
    expect(screen.getByText(/could not be read: not valid JSON/u)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open brief\.md/u })).toBeNull();
  });

  it('shows a too-large document with Show in folder', async () => {
    await open(
      runView({
        document: {
          kind: 'brief',
          slot: { state: 'too_large', path: 'brief.json', bytes: 900_000, cap: 524_288 },
        },
      }),
    );
    expect(
      screen.getByText(/too large to show here: 878\.9 KiB, over the 512\.0 KiB limit/u),
    ).toBeTruthy();
    expect(screen.getByText(`yantra open ${RUN_ID} --artifact dir`)).toBeTruthy();
  });
});

describe('the page', () => {
  it('shows the outcome, mode, times and the CLI twin', async () => {
    await open(briefView(brief()));
    expect(screen.getByRole('heading', { level: 1, name: 'E-bike comparison' })).toBeTruthy();
    expect(screen.getByText('completed fulfilled')).toBeTruthy();
    expect(screen.getByText('research')).toBeTruthy();
    expect(screen.getByText('1 min')).toBeTruthy();
    expect(screen.getByText(`yantra open ${RUN_ID}`)).toBeTruthy();
  });

  it('shows a live run’s state and never calls an unverifiable owner running', async () => {
    await open(
      briefView(brief(), {
        live: { state: 'unknown_owner' },
        status: 'running',
        task_outcome: null,
      }),
    );
    expect(screen.getByText('status unknown')).toBeTruthy();
    expect(
      screen.getByText('Status unknown — the owner of this run can’t be verified.'),
    ).toBeTruthy();
  });

  it('lists the public files on the Files tab with their action', async () => {
    await open(briefView(brief()));
    await userEvent.click(screen.getByRole('tab', { name: 'Files' }));
    const list = screen.getByRole('list', { name: 'Run files' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-file')),
    ).toEqual(['brief.json', 'brief.md', 'brief.html', 'report.md']);
    expect(within(list).getByText('Shown on the Result tab')).toBeTruthy();
    expect(within(list).getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('says so for an unknown run, with a way back to the Ledger', async () => {
    const rpc = new FakeRpc().answer('read.run_result', () => {
      throw new RpcCallError(
        'read.run_result',
        -32004,
        'Run x was not found.',
        'not_found',
        undefined,
      );
    });
    await renderAt(`/runs/${RUN_ID}`, rpc);
    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the Ledger' }).getAttribute('href')).toBe(
      '/runs',
    );
  });

  it('has no axe violations on a full Brief page', async () => {
    const full = brief({
      ...briefVariants().alternatives,
      constraints: briefVariants().constraints!.constraints,
      sources: [...briefVariants().consulted!.sources],
    });
    const { container } = await open(briefView(full));
    await expectNoAxeViolations(container);
  });
});
