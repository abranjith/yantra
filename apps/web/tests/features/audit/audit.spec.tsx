// @no-llm
/**
 * The app's Audit (FEAT-066 TASK-009): the `yantra audit` story, keys-only
 * secrets, words verbatim, capture destinations and cursor paging.
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import { AuditPage, type AuditReport } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../support/axe.js';
import { RUN_ID, runView } from '../../support/briefs.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import {
  installIntersectionObserver,
  resetIntersectionObservers,
  setIntersecting,
} from '../../support/intersection-observer.js';
import { useFixedLayout } from '../../support/layout.js';

useFixedLayout(1200, 600);

beforeEach(() => {
  installIntersectionObserver();
});

afterEach(() => {
  resetIntersectionObservers();
});

const SHA = 'c'.repeat(64);

function call(seq: number, overrides: Partial<AuditReport['toolCalls'][number]> = {}) {
  return {
    seq,
    callId: `call-${String(seq)}`,
    tool: 'web_fetch',
    status: 'ok' as const,
    durationMs: 120,
    confirmationId: null,
    confirmationDecision: null,
    incomplete: false,
    ...overrides,
  };
}

function capture(part: number, sentToModel: boolean) {
  return {
    path: `screenshots/capture-1-${SHA.slice(0, 12)}-p${String(part)}.png`,
    sha256: SHA,
    mimeType: 'image/png' as const,
    width: 1280,
    height: 800,
    bytes: 4000,
    sentToModel,
    toolCall: { seq: 4, callId: 'call-4', tool: 'browser_screenshot' },
    budgetConsumed: { captures: 1 as const, pixels: 1_024_000, bytes: 4000 },
  };
}

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    runId: RUN_ID,
    workflowName: 'do',
    status: 'completed',
    startedAt: '2026-11-01T00:00:00.000Z',
    endedAt: '2026-11-01T00:00:03.000Z',
    durationMs: 3000,
    llmCallCount: 2,
    secretLookups: [{ key: 'shop_password', stepId: 'fill-1', ts: '2026-11-01T00:00:01.000Z' }],
    stepCount: 0,
    scopeMix: { publicCount: 0, readOnlyDataCount: 0, authenticatedCount: 0 },
    trustNarrative:
      'Run completed in 3.0s. The agent made 2 LLM calls (sanitized prompts only) and 1 secret lookup were performed (keys only — never values). The engine executed 0 steps.',
    agent: {
      adapter: 'pi-coding-agent',
      sdkVersion: '0.80.6',
      provider: 'anthropic',
      model: 'claude-sonnet',
      thinking: 'medium',
      authSource: 'environment',
      sessionId: 'session-1',
      sessionFile: 'agent/session-1.jsonl',
      promptVersion: 'agent-v1',
    },
    toolCalls: [
      call(0),
      call(2, {
        tool: 'browser_click',
        status: 'denied',
        confirmationId: 'confirm-1',
        confirmationDecision: 'denied',
      }),
      call(5, { tool: 'web_search', status: 'incomplete', durationMs: null, incomplete: true }),
    ],
    captures: [capture(1, true), capture(2, false)],
    rawSessionLogCaptureBearing: true,
    usage: { turns: 2, inputTokens: 20, outputTokens: 8, costUsd: 0.04 },
    terminalError: null,
    ...overrides,
  };
}

function page(value: AuditReport, toolCursor: string | null = null): AuditPage {
  return AuditPage.parse({
    report: value,
    tool_calls: { total: value.toolCalls.length, next_cursor: toolCursor },
    captures: { total: value.captures.length, next_cursor: null },
  });
}

async function openAudit(answer: (params: Record<string, unknown>) => AuditPage) {
  const rpc = new FakeRpc()
    .answer(
      'read.run_result',
      runView({
        artifacts: [
          {
            path: 'agent/session-1.jsonl',
            entry_id: 'agent-session',
            exposure: 'view',
            viewer: 'jsonl',
            bytes: 10,
            modified_at: '2026-11-01T00:00:00.000Z',
            over_inline_cap: false,
          },
        ],
      }),
    )
    .answer('read.audit', answer)
    .answer('artifact.url', (params) => ({
      url: `/a/${String(params.path)}.mac`,
      expires_at: '2026-11-01T00:05:00.000Z',
    }));
  const rendered = await renderAt(`/runs/${RUN_ID}/audit`, rpc);
  await screen.findByText(/Run completed in 3\.0s/u);
  return { ...rendered, rpc };
}

function region(id: string): HTMLElement {
  return document.querySelector(`[data-audit-region="${id}"]`)!;
}

describe('the Audit', () => {
  it('opens on the Audit tab at /runs/<id>/audit and tells the trust narrative', async () => {
    await openAudit(() => page(report()));
    expect(screen.getByRole('tab', { name: 'Audit', selected: true })).toBeTruthy();
    expect(document.querySelector('[data-part="trust-narrative"]')?.textContent).toBe(
      report().trustNarrative,
    );
  });

  it('shows provenance with the session log as an artifact link', async () => {
    await openAudit(() => page(report()));
    const provenance = region('audit-provenance');
    for (const word of [
      'pi-coding-agent',
      '0.80.6',
      'anthropic',
      'claude-sonnet',
      'medium',
      'environment',
      'agent-v1',
    ]) {
      expect(within(provenance).getByText(word)).toBeTruthy();
    }
    expect(
      within(provenance).getByRole('link', { name: 'agent/session-1.jsonl' }).getAttribute('href'),
    ).toBe(`/runs/${RUN_ID}/artifacts/agent/session-1.jsonl`);
  });

  it('lists secret keys with a ProtectedValue and never a value element', async () => {
    await openAudit(() => page(report()));
    const secrets = region('audit-secrets');
    const item = secrets.querySelector('[data-secret-key="shop_password"]')!;
    expect(item.textContent).toContain('shop_password');
    expect(item.querySelector('[data-part="protected-value"]')).not.toBeNull();
    expect(secrets.querySelector('input, [data-value]')).toBeNull();
  });

  it('shows tool-call status and confirmation words verbatim', async () => {
    await openAudit(() => page(report()));
    const table = screen.getByRole('grid', { name: 'Tool calls (3)' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['web_fetch', 'browser_click', 'web_search']);
    const cells = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        [...row.querySelectorAll('[role="rowheader"], [role="gridcell"]')].map(
          (cell) => cell.textContent,
        ),
      );
    expect(cells[1]).toEqual(['2', 'browser_click', 'denied', '120 ms', 'denied', 'yes']);
    expect(cells[2]).toEqual(['5', 'web_search', 'incomplete', '—', '—', 'incomplete']);
  });

  it('says where each capture went and warns about the raw session log', async () => {
    await openAudit(() => page(report()));
    const captures = region('audit-captures');
    expect(within(captures).getByText('sent to model')).toBeTruthy();
    expect(within(captures).getByText('kept on this computer')).toBeTruthy();
    expect(within(captures).getByRole('note').textContent).toBe(
      'Raw provider session log agent/session-1.jsonl contains the image data itself.',
    );
  });

  it('shows a startup failure and no usage', async () => {
    await openAudit(() =>
      page(
        report({
          agent: null,
          usage: null,
          llmCallCount: 0,
          captures: [],
          rawSessionLogCaptureBearing: false,
          toolCalls: [],
          terminalError: { code: 'AGENT_AUTH_UNAVAILABLE', message: 'No credentials.' },
        }),
      ),
    );
    expect(within(region('audit-terminal-error')).getByText('AGENT_AUTH_UNAVAILABLE')).toBeTruthy();
    expect(
      within(region('audit-provenance')).getByText('This run made no agent session.'),
    ).toBeTruthy();
    expect(within(region('audit-usage')).getByText(/No provider usage recorded/u)).toBeTruthy();
  });

  it('pages tool calls by cursor as the table scrolls', async () => {
    const first = report({ toolCalls: [call(0), call(1)] });
    const second = report({ toolCalls: [call(2), call(3)] });
    const { rpc } = await openAudit((params) =>
      params.tool_calls_cursor === 'next-1' ? page(second) : page(first, 'next-1'),
    );

    act(() => {
      setIntersecting(true);
    });

    await waitFor(() => {
      expect(
        rpc.paramsOf('read.audit').some((params) => params.tool_calls_cursor === 'next-1'),
      ).toBe(true);
    });
    const table = screen.getByRole('grid', { name: /Tool calls/u });
    await waitFor(() => {
      expect(within(table).getAllByRole('rowheader')).toHaveLength(4);
    });
  });

  it('has no axe violations', async () => {
    const { container } = await openAudit(() => page(report()));
    await expectNoAxeViolations(container);
  });
});
