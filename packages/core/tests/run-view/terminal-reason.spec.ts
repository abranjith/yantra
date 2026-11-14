// @no-llm
/**
 * The terminal-reason chain (FEAT-066 TASK-004): run_outcome, then the
 * manifest, then events.jsonl, then report.md; ANSI-stripped, bounded text.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunDir, jsonl } from '@yantra/test-helpers/run-dirs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TERMINAL_TAIL_BYTES,
  boundedText,
  readTerminalReason,
  type TerminalManifestFields,
} from '../../src/run-view/terminal-reason.js';

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'yantra-terminal-'));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

const NO_MANIFEST: TerminalManifestFields = {
  terminationReason: null,
  failureClass: null,
  agentError: null,
};

function outcome(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '1',
    seq,
    run_id: 'r',
    event: {
      kind: 'run_outcome',
      run_id: 'r',
      task_outcome: 'failed',
      termination_reason: 'tool-budget',
      stop_detail: null,
      exit_code: 2,
      failure_class: 'budget_exhausted',
      at: '2026-11-01T00:00:00.000Z',
      ...overrides,
    },
  };
}

const MANIFEST: TerminalManifestFields = {
  terminationReason: 'provider_failed',
  failureClass: null,
  agentError: { code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'Provider down' },
};

async function dir(files: Record<string, string>): Promise<string> {
  return buildRunDir(runsDir, { runId: 'run', manifest: null, files });
}

describe('readTerminalReason', () => {
  it('takes the last run_outcome first', async () => {
    const runDir = await dir({
      'run-events.jsonl': jsonl([outcome(1, { failure_class: null }), outcome(2)]),
      'events.jsonl': jsonl([{ kind: 'task_failed', failure_class: 'navigation_timeout' }]),
    });

    expect(await readTerminalReason(runDir, MANIFEST)).toEqual({
      source: 'run_outcome',
      failure_class: 'budget_exhausted',
      termination_reason: 'tool-budget',
    });
  });

  it('skips run-events lines that are not a valid run_outcome', async () => {
    const runDir = await dir({
      'run-events.jsonl': `${jsonl([outcome(1)])}not json\n${JSON.stringify({ schema_version: '1', seq: 2, run_id: 'r', event: { kind: 'run_outcome' } })}\n`,
    });
    expect((await readTerminalReason(runDir, NO_MANIFEST))?.failure_class).toBe('budget_exhausted');
  });

  it('ignores a trailing partial run-events line', async () => {
    const runDir = await dir({
      'run-events.jsonl': `${jsonl([outcome(1)])}${JSON.stringify(outcome(2, { failure_class: 'captcha_detected' }))}`,
    });
    expect((await readTerminalReason(runDir, NO_MANIFEST))?.failure_class).toBe('budget_exhausted');
  });

  it('falls back to the manifest', async () => {
    const runDir = await dir({
      'events.jsonl': jsonl([{ kind: 'task_failed', failure_class: 'navigation_timeout' }]),
    });
    expect(await readTerminalReason(runDir, MANIFEST)).toEqual({
      source: 'manifest',
      failure_class: 'AGENT_PROVIDER_UNAVAILABLE',
      message: 'Provider down',
      termination_reason: 'provider_failed',
    });
  });

  it('prefers the manifest failure class over the startup error code', async () => {
    const runDir = await dir({});
    expect(
      await readTerminalReason(runDir, { ...MANIFEST, failureClass: 'captcha_detected' }),
    ).toMatchObject({ failure_class: 'captcha_detected', message: 'Provider down' });
  });

  it('falls back to the last task_failed in events.jsonl', async () => {
    const runDir = await dir({
      'events.jsonl': jsonl([
        { kind: 'task_failed', failure_class: 'locator_not_found' },
        { kind: 'step_started', step_id: 's2' },
        { kind: 'task_failed', failure_class: 'navigation_timeout' },
      ]),
    });
    expect(await readTerminalReason(runDir, NO_MANIFEST)).toEqual({
      source: 'events',
      failure_class: 'navigation_timeout',
    });
  });

  it('reads a handoff from events.jsonl as the blocker', async () => {
    const runDir = await dir({
      'events.jsonl': jsonl([{ kind: 'human_handoff_requested', step_id: 's', reason: 'captcha' }]),
    });
    expect(await readTerminalReason(runDir, NO_MANIFEST)).toEqual({
      source: 'events',
      blocker: 'captcha',
    });
  });

  it('falls back to the failure section of report.md', async () => {
    const runDir = await dir({
      'report.md':
        '# Report\n\n## Summary\nok\n\n## Failure (if any)\nFailure class: rate_limited\nCause: Too many requests\n\n## Tool Calls\n- none\n',
    });
    expect(await readTerminalReason(runDir, NO_MANIFEST)).toEqual({
      source: 'report',
      failure_class: 'rate_limited',
      message: 'Too many requests',
    });
  });

  it('reads a handoff section with its blocker and safest next action', async () => {
    const runDir = await dir({
      'report.md':
        '## Handoff\nBlocker: Verification page\nSafest next action: Complete it, then rerun.\n',
    });
    expect(await readTerminalReason(runDir, NO_MANIFEST)).toEqual({
      source: 'report',
      blocker: 'Verification page',
      safest_next_action: 'Complete it, then rerun.',
    });
  });

  it('ignores a failure section that records none', async () => {
    const runDir = await dir({
      'report.md': '## Failure (if any)\nFailure class: none\nCause: n/a\n',
    });
    expect(await readTerminalReason(runDir, NO_MANIFEST)).toBeNull();
  });

  it('is null when nothing recorded why the run ended', async () => {
    expect(await readTerminalReason(await dir({}), NO_MANIFEST)).toBeNull();
    expect(await readTerminalReason(await dir({ 'report.md': '# Report\n' }), null)).toBeNull();
  });

  it('reads only the tail of a huge events file', async () => {
    const filler = jsonl(
      Array.from({ length: 20_000 }, (_, i) => ({
        kind: 'step_started',
        step_id: `s${String(i)}`,
      })),
    );
    const runDir = await dir({
      'events.jsonl': `${jsonl([{ kind: 'task_failed', failure_class: 'early' }])}${filler}`,
    });
    expect(filler.length).toBeGreaterThan(TERMINAL_TAIL_BYTES);
    // The early failure is outside the tail; nothing later records one.
    expect(await readTerminalReason(runDir, NO_MANIFEST)).toBeNull();
  });
});

describe('boundedText', () => {
  it('strips ANSI and control characters', () => {
    expect(boundedText('\u001b[31mred\u001b[0m and \u0007bell\u0000')).toBe('red and bell');
    expect(boundedText('\u001b]0;title\u0007after')).toBe('after');
  });

  it('cuts to 500 characters with an ellipsis', () => {
    const text = boundedText('x'.repeat(900));
    expect(text).toHaveLength(500);
    expect(text.endsWith('…')).toBe(true);
  });

  it('bounds text read from the manifest', async () => {
    const runDir = await dir({});
    const reason = await readTerminalReason(runDir, {
      ...NO_MANIFEST,
      agentError: { code: 'X', message: `\u001b[1m${'m'.repeat(800)}` },
    });
    expect(reason?.message).toHaveLength(500);
    expect(reason?.message?.startsWith('m')).toBe(true);
  });
});
