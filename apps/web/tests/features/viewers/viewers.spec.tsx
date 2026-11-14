// @no-llm
/**
 * Bounded and windowed artifact viewers (FEAT-066 TASK-008).
 */

import { screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { RUN_EVENT_KINDS, type JsonlWindow } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVENT_SUMMARIES, summarizeEvent } from '../../../src/features/viewers/event-summary.js';
import { ShowInFolder, showInFolderCommand } from '../../../src/features/viewers/ShowInFolder.js';
import { expectNoAxeViolations } from '../../support/axe.js';
import { RUN_ID, runView } from '../../support/briefs.js';
import { FakeRpc, renderAt } from '../../support/fake-rpc.js';
import {
  installIntersectionObserver,
  resetIntersectionObservers,
} from '../../support/intersection-observer.js';
import { useFixedLayout } from '../../support/layout.js';

useFixedLayout(1200, 600);

beforeEach(() => {
  installIntersectionObserver();
});

afterEach(() => {
  resetIntersectionObservers();
  vi.unstubAllGlobals();
});

function item(path: string, viewer: string, extra: Record<string, unknown> = {}) {
  return {
    path,
    entry_id: path,
    exposure: 'view',
    viewer,
    bytes: 100,
    modified_at: '2026-11-01T00:00:00.000Z',
    over_inline_cap: false,
    ...extra,
  };
}

/** A fake file of `total` lines whose text comes from `lineAt`. */
function windows(total: number, lineAt: (n: number) => string) {
  return (params: Record<string, unknown>): JsonlWindow => {
    const from = Number(params.from_line);
    const limit = Number(params.limit);
    const lines = [];
    for (let n = from; n < Math.min(total, from + limit); n++) {
      lines.push({ n, text: lineAt(n), truncated_bytes: 0 });
    }
    return {
      path: String(params.path),
      total_lines_known: total,
      total_complete: true,
      from_line: from,
      lines,
      partial_tail: false,
    };
  };
}

async function openViewer(path: string, artifacts: unknown[], rpc: FakeRpc) {
  rpc.answer('read.run_result', runView({ artifacts }));
  const rendered = await renderAt(`/runs/${RUN_ID}/artifacts/${path}`, rpc);
  await screen.findByRole('heading', { level: 1, name: path });
  return rendered;
}

describe('JsonlViewer', () => {
  it('keeps the DOM bounded for 50,000 lines', async () => {
    const rpc = new FakeRpc().answer(
      'read.artifact_window',
      windows(50_000, (n) => JSON.stringify({ seq: n, tool: 'web_fetch' })),
    );
    await openViewer('tool-calls.jsonl', [item('tool-calls.jsonl', 'jsonl')], rpc);

    const table = await screen.findByRole('grid', { name: 'tool-calls.jsonl lines' });
    await waitFor(() => {
      expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
    });
    expect(within(table).getAllByRole('row').length).toBeLessThanOrEqual(100);
    expect(screen.getByText('50000 lines')).toBeTruthy();
    // Only the windows for the visible rows were read.
    expect(rpc.paramsOf('read.artifact_window').length).toBeLessThanOrEqual(3);
  }, 30_000);

  it('shows an invalid line raw with a "not valid JSON" chip, failing only itself', async () => {
    const rpc = new FakeRpc().answer(
      'read.artifact_window',
      windows(3, (n) => (n === 1 ? '{"broken": ' : JSON.stringify({ n }))),
    );
    await openViewer('runtime.jsonl', [item('runtime.jsonl', 'jsonl')], rpc);

    const chip = await screen.findByText('not valid JSON');
    const row = chip.closest('[role="row"]')!;
    expect(row.textContent).toContain('{"broken":');
    expect(row.querySelector('[data-line="1"]')).not.toBeNull();
    expect(screen.getAllByText('not valid JSON')).toHaveLength(1);
  });

  it('summarizes known events and opens an unknown kind in the EventInspector', async () => {
    const lines = [
      JSON.stringify({
        kind: 'step_started',
        step_id: 's1',
        scope: 'public',
        task_id: 't',
        at: 'x',
      }),
      JSON.stringify({ kind: 'teleport_requested', destination: '<b>mars</b>' }),
    ];
    const rpc = new FakeRpc().answer(
      'read.artifact_window',
      windows(2, (n) => lines[n]!),
    );
    await openViewer('events.jsonl', [item('events.jsonl', 'jsonl')], rpc);

    expect(await screen.findByText('step started · s1 · public')).toBeTruthy();
    await userEvent.click(screen.getByText(lines[1]!));

    const inspector = await screen.findByRole('group', { name: 'Line 2 details' });
    expect(within(inspector).getByText('"teleport_requested"')).toBeTruthy();
    expect(inspector.querySelector('b')).toBeNull();
  });

  it('marks a line cut at 16 KiB', async () => {
    const rpc = new FakeRpc().answer('read.artifact_window', (params: Record<string, unknown>) => ({
      ...windows(1, () => '{"blob": "xxxx')(params),
      lines: [{ n: 0, text: '{"blob": "xxxx', truncated_bytes: 90_000 }],
    }));
    await openViewer('tool-calls.jsonl', [item('tool-calls.jsonl', 'jsonl')], rpc);
    expect(await screen.findByText('cut at 16 KiB')).toBeTruthy();
  });

  it('goes to the end and shows the last line in full', async () => {
    const rpc = new FakeRpc().answer(
      'read.artifact_window',
      windows(1_000, (n) => JSON.stringify({ seq: n })),
    );
    await openViewer('tool-calls.jsonl', [item('tool-calls.jsonl', 'jsonl')], rpc);
    await screen.findByRole('grid', { name: 'tool-calls.jsonl lines' });

    await userEvent.click(screen.getByRole('button', { name: 'Go to the end' }));

    const detail = await screen.findByRole('region', { name: 'Line 1000' });
    expect(within(detail).getByText('999')).toBeTruthy();
  });

  it('has no axe violations', async () => {
    const rpc = new FakeRpc().answer(
      'read.artifact_window',
      windows(5, (n) => JSON.stringify({ n })),
    );
    const { container } = await openViewer('runtime.jsonl', [item('runtime.jsonl', 'jsonl')], rpc);
    await screen.findByRole('grid', { name: 'runtime.jsonl lines' });
    await expectNoAxeViolations(container);
  });
});

describe('event summaries', () => {
  it('only summarize kinds the protocol defines', () => {
    const known = new Set<string>(RUN_EVENT_KINDS);
    expect(Object.keys(EVENT_SUMMARIES).filter((kind) => !known.has(kind))).toEqual([]);
  });

  it('read a run-event record’s inner event', () => {
    expect(
      summarizeEvent({
        schema_version: '1',
        seq: 3,
        run_id: 'r',
        event: { kind: 'run_outcome', task_outcome: 'partial' },
      }),
    ).toBe('run outcome · partial');
    expect(summarizeEvent({ kind: 'unknown_thing' })).toBeNull();
    expect(summarizeEvent('text')).toBeNull();
  });
});

describe('whole-file viewers', () => {
  it('opens a JSON file within its cap through a signed URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{"status":"completed","kind":"x"}'))),
    );
    const rpc = new FakeRpc().answer('artifact.url', {
      url: '/a/m.mac',
      expires_at: '2026-11-01T00:05:00.000Z',
    });
    await openViewer('manifest.json', [item('manifest.json', 'json')], rpc);

    expect(await screen.findByRole('group', { name: 'manifest.json' })).toBeTruthy();
    expect(screen.getByText('"completed"')).toBeTruthy();
  });

  it('never loads a file over its cap; it offers Show in folder', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const rpc = new FakeRpc();
    await openViewer(
      'outputs.json',
      [item('outputs.json', 'json', { bytes: 3_000_000, over_inline_cap: true })],
      rpc,
    );

    expect(screen.getByText(/too large to open here/u)).toBeTruthy();
    expect(screen.getByText(showInFolderCommand(RUN_ID))).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    expect(rpc.paramsOf('artifact.url')).toEqual([]);
  });

  it('shows an over-cap image as a placeholder with Show in folder', async () => {
    const rpc = new FakeRpc();
    await openViewer(
      'captures/huge.png',
      [item('captures/huge.png', 'image', { bytes: 30_000_000, over_inline_cap: true })],
      rpc,
    );
    expect(screen.getByText(/too large to show here/u)).toBeTruthy();
    expect(rpc.paramsOf('artifact.url')).toEqual([]);
  });

  it('says so for a file the run does not list', async () => {
    await openViewer('lease.json', [], new FakeRpc());
    expect(screen.getByText('This file is not one the app can show for this run.')).toBeTruthy();
  });
});

describe('ShowInFolder', () => {
  it('falls back to the copyable CLI twin when invocation is unavailable', () => {
    render(<ShowInFolder runId={RUN_ID} />);
    expect(screen.getByText(`yantra open ${RUN_ID} --artifact dir`)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: `Copy yantra open ${RUN_ID} --artifact dir` }),
    ).toBeTruthy();
  });

  it('is one button when the host can run it, and falls back if it fails', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error('read-only host')));
    render(<ShowInFolder runId={RUN_ID} invoke={invoke} />);

    await userEvent.click(screen.getByRole('button', { name: 'Show in folder' }));

    expect(invoke).toHaveBeenCalledOnce();
    expect(await screen.findByText(`yantra open ${RUN_ID} --artifact dir`)).toBeTruthy();
  });
});
