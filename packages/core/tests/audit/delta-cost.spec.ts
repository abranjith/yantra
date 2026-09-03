/**
 * The cost reader, tested as a reader: it reports the artifact and claims
 * nothing from it.
 *
 * The one measurement that cannot be a field on a result is the follow-up
 * observe rate, because it is a property of the *sequence* of calls. Most of
 * these cases are about getting that sequence right.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolAuditEntry, type ToolAuditEntryType } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { summarizeDeltaCost } from '../../src/audit/delta-cost.js';
import { ToolCallWriter } from '../../src/audit/tool-call-writer.js';

let seq = 0;

function entry(
  tool: string,
  overrides: {
    readonly phase?: 'start' | 'end';
    readonly details?: Record<string, unknown>;
    readonly seq?: number;
  } = {},
): ToolAuditEntryType {
  const phase = overrides.phase ?? 'end';
  return {
    ts: '2026-09-02T00:00:00.000Z',
    seq: overrides.seq ?? seq++,
    run_id: 'run',
    session_id: 'session',
    call_id: `call-${seq}`,
    tool,
    phase,
    input_sanitized: phase === 'start' ? {} : null,
    output_sanitized:
      phase === 'start' ? null : { details: overrides.details ?? null, status: 'ok' },
    status: phase === 'start' ? null : 'ok',
    duration_ms: phase === 'start' ? null : 10,
    error_code: null,
    confirmation_id: null,
  };
}

const withDelta = (tool: string, deltaBytes: number, observationBytes: number) =>
  entry(tool, { details: { delta_bytes: deltaBytes, observation_bytes: observationBytes } });

describe('@no-llm summarizeDeltaCost', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('totals the bytes of every delta-bearing call', () => {
    const summary = summarizeDeltaCost([
      withDelta('browser_click', 120, 4_000),
      withDelta('browser_fill_form', 340, 6_000),
    ]);

    expect(summary.calls).toBe(2);
    expect(summary.deltaBytesTotal).toBe(460);
    expect(summary.deltaBytesMax).toBe(340);
    expect(summary.observationBytesTotal).toBe(10_000);
  });

  it('counts an observe immediately after a delta-bearing action as a follow-up', () => {
    const summary = summarizeDeltaCost([
      withDelta('browser_click', 100, 3_000),
      entry('browser_observe'),
    ]);

    expect(summary.followUpObserveCount).toBe(1);
    expect(summary.followUpObserveRate).toBe(1);
  });

  it('does not count an observe that followed another observe', () => {
    const summary = summarizeDeltaCost([
      withDelta('browser_click', 100, 3_000),
      entry('browser_observe'),
      entry('browser_observe'),
    ]);

    expect(summary.followUpObserveCount).toBe(1);
  });

  it('does not count an observe after an action that carried no delta', () => {
    const summary = summarizeDeltaCost([
      entry('browser_navigate', { details: { delta_omitted: 'no-baseline' } }),
      entry('browser_observe'),
    ]);

    expect(summary.calls).toBe(0);
    expect(summary.followUpObserveCount).toBe(0);
  });

  it('reads entries in seq order, whatever order they arrive in', () => {
    const action = withDelta('browser_click', 100, 3_000);
    const observe = entry('browser_observe');

    // A pair read out of order would attribute the follow-up to the wrong
    // predecessor, which is the whole content of this measurement.
    expect(summarizeDeltaCost([observe, action]).followUpObserveCount).toBe(1);
  });

  it('ignores start-phase entries, which carry no output at all', () => {
    const summary = summarizeDeltaCost([
      entry('browser_click', { phase: 'start' }),
      withDelta('browser_click', 100, 3_000),
    ]);

    expect(summary.calls).toBe(1);
  });

  it('reports a rate of zero for a run with no observes', () => {
    const summary = summarizeDeltaCost([withDelta('browser_click', 100, 3_000)]);

    expect(summary.followUpObserveRate).toBe(0);
  });

  it('handles an empty list without dividing by zero', () => {
    expect(summarizeDeltaCost([])).toEqual({
      calls: 0,
      deltaBytesTotal: 0,
      deltaBytesMax: 0,
      observationBytesTotal: 0,
      followUpObserveCount: 0,
      followUpObserveRate: 0,
    });
  });

  it('reports a fractional rate over several calls', () => {
    const summary = summarizeDeltaCost([
      withDelta('browser_click', 100, 3_000),
      entry('browser_observe'),
      withDelta('browser_click', 100, 3_000),
      withDelta('browser_fill_element', 100, 3_000),
      withDelta('browser_navigate', 100, 3_000),
    ]);

    expect(summary.calls).toBe(4);
    expect(summary.followUpObserveRate).toBeCloseTo(0.25);
  });

  it('ignores a details payload whose byte fields are not numbers', () => {
    const summary = summarizeDeltaCost([
      entry('browser_click', { details: { delta_bytes: 'lots', observation_bytes: null } }),
    ]);

    expect(summary.calls).toBe(0);
  });

  it('tolerates a null or non-object output', () => {
    const broken = { ...entry('browser_click'), output_sanitized: null };
    expect(summarizeDeltaCost([broken]).calls).toBe(0);
  });
});

describe('@no-llm delta cost, read back off a written artifact', () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-delta-cost-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('round-trips through tool-calls.jsonl with an explicit UTF-8 decoder', async () => {
    const writer = ToolCallWriter.forRun(runDir);
    // An accessible name with non-ASCII text, because the decoder is the point:
    // Windows PowerShell 5.1 defaults `Get-Content` to ANSI, and two separate
    // investigations here raised false mojibake alarms caused by the *reader*.
    for (const record of [
      withDelta('browser_click', 210, 5_120),
      entry('browser_observe'),
      entry('browser_fill_form', {
        details: { delta_bytes: 480, observation_bytes: 9_001, note: 'Rechercher un séjour' },
      }),
    ]) {
      const { seq: _seq, ...input } = record;
      await writer.append(input);
    }
    await writer.close();

    const text = await readFile(join(runDir, 'tool-calls.jsonl'), { encoding: 'utf8' });
    const entries = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => ToolAuditEntry.parse(JSON.parse(line)));

    expect(text).toContain('séjour');
    const summary = summarizeDeltaCost(entries);
    expect(summary.calls).toBe(2);
    expect(summary.deltaBytesTotal).toBe(690);
    expect(summary.deltaBytesMax).toBe(480);
    expect(summary.observationBytesTotal).toBe(14_121);
    expect(summary.followUpObserveCount).toBe(1);
    expect(summary.followUpObserveRate).toBeCloseTo(0.5);
  });

  it('reads a run directory that recorded no delta at all without failing', async () => {
    await writeFile(
      join(runDir, 'tool-calls.jsonl'),
      `${JSON.stringify(entry('web_search'))}\n`,
      'utf8',
    );

    const text = await readFile(join(runDir, 'tool-calls.jsonl'), { encoding: 'utf8' });
    const entries = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => ToolAuditEntry.parse(JSON.parse(line)));

    expect(summarizeDeltaCost(entries).followUpObserveRate).toBe(0);
  });
});
