// @no-llm
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AGENT_PROGRESS_KINDS,
  AGENT_PROGRESS_SHAPES,
  AgentProgressEvent,
  CONTRACT_SUMMARY_MAX,
  LIVE_ITEM_LABEL_MAX,
  LiveItem,
  PROGRESS_SUMMARY_MAX,
} from '../src/index.js';

const at = '2026-11-01T00:00:00.000Z';

/** One literal per variant, in the exact key order the agent runtime emits. */
export const AGENT_PROGRESS_LITERALS = {
  recovery: {
    type: 'recovery',
    rung: 'freeze',
    trigger: 'turn-timeout',
    move: 'publish',
    summary: 'thinking exceeded 60s; exploration closed, publish only',
    at,
  },
  progress: {
    type: 'progress',
    items: [
      { id: 'fill:email', kind: 'fill', label: 'email', state: 'met', done: 1, total: 1 },
      {
        id: 'artifact:screenshot:viewport',
        kind: 'artifact',
        label: 'screenshot',
        state: 'pending',
        done: null,
        total: null,
      },
    ],
    summary: 'email filled; screenshot pending',
    at,
  },
  assistant_text: { type: 'assistant_text', text: 'Opening the page.\n', at },
  tool_started: { type: 'tool_started', tool: 'browser_navigate', summary: 'fields: url', at },
  tool_finished: {
    type: 'tool_finished',
    tool: 'browser_navigate',
    summary: 'error: LOCATOR_NOT_FOUND',
    status: 'error',
    durationMs: null,
    at,
  },
  contract_declared: { type: 'contract_declared', revision: 2, summary: 'fill the form', at },
  capability_gap: {
    type: 'capability_gap',
    item: 'artifact:screenshot:full_page',
    reason: 'suppressed_by_flag',
    summary: 'Cannot deliver: a full-page screenshot.',
    at,
  },
} as const;

describe('@no-llm AgentProgressEvent', () => {
  it.each(AGENT_PROGRESS_KINDS)('parses a %s literal unchanged, keys in order', (kind) => {
    const literal = AGENT_PROGRESS_LITERALS[kind];
    const parsed = AgentProgressEvent.parse(literal);

    expect(parsed).toEqual(literal);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(literal));
  });

  it('declares exactly the seven runtime variants', () => {
    expect([...AGENT_PROGRESS_KINDS].sort()).toEqual(
      [
        'assistant_text',
        'capability_gap',
        'contract_declared',
        'progress',
        'recovery',
        'tool_finished',
        'tool_started',
      ].sort(),
    );
    expect(AgentProgressEvent.options.map((o) => o.shape.type.value)).toEqual([
      ...AGENT_PROGRESS_KINDS,
    ]);
  });

  it('rejects an unknown type', () => {
    expect(AgentProgressEvent.safeParse({ type: 'tool_paused', tool: 'x', at }).success).toBe(
      false,
    );
  });

  it('rejects a variant spelled with `kind` instead of `type`', () => {
    const { type: _type, ...rest } = AGENT_PROGRESS_LITERALS.tool_started;
    expect(AgentProgressEvent.safeParse({ kind: 'tool_started', ...rest }).success).toBe(false);
  });

  it('keeps `durationMs` camelCase, as `do --json` prints it', () => {
    expect(Object.keys(AGENT_PROGRESS_SHAPES.tool_finished)).toContain('durationMs');
    expect(
      AgentProgressEvent.safeParse({
        ...AGENT_PROGRESS_LITERALS.tool_finished,
        durationMs: undefined,
        duration_ms: 3,
      }).success,
    ).toBe(false);
  });

  it('applies the producers’ own bounds and no others', () => {
    const long = (n: number): string => 'x'.repeat(n);
    const ok = (value: unknown): boolean => AgentProgressEvent.safeParse(value).success;

    expect(ok({ ...AGENT_PROGRESS_LITERALS.progress, summary: long(PROGRESS_SUMMARY_MAX) })).toBe(
      true,
    );
    expect(
      ok({ ...AGENT_PROGRESS_LITERALS.progress, summary: long(PROGRESS_SUMMARY_MAX + 1) }),
    ).toBe(false);
    expect(
      ok({ ...AGENT_PROGRESS_LITERALS.contract_declared, summary: long(CONTRACT_SUMMARY_MAX + 1) }),
    ).toBe(false);
    // Unbounded today (a streamed delta, a tool summary): still unbounded.
    expect(ok({ ...AGENT_PROGRESS_LITERALS.assistant_text, text: long(50_000) })).toBe(true);
    expect(ok({ ...AGENT_PROGRESS_LITERALS.tool_started, summary: long(5_000) })).toBe(true);
  });

  it('rejects a negative duration, a zero revision and a bad timestamp', () => {
    expect(
      AgentProgressEvent.safeParse({ ...AGENT_PROGRESS_LITERALS.tool_finished, durationMs: -1 })
        .success,
    ).toBe(false);
    expect(
      AgentProgressEvent.safeParse({ ...AGENT_PROGRESS_LITERALS.contract_declared, revision: 0 })
        .success,
    ).toBe(false);
    expect(
      AgentProgressEvent.safeParse({ ...AGENT_PROGRESS_LITERALS.assistant_text, at: 'yesterday' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown recovery move and an unknown capability reason', () => {
    expect(
      AgentProgressEvent.safeParse({ ...AGENT_PROGRESS_LITERALS.recovery, move: 'retry' }).success,
    ).toBe(false);
    expect(
      AgentProgressEvent.safeParse({ ...AGENT_PROGRESS_LITERALS.capability_gap, reason: 'other' })
        .success,
    ).toBe(false);
  });
});

describe('@no-llm LiveItem', () => {
  it('bounds the label at the ledger’s 60 characters', () => {
    const item = AGENT_PROGRESS_LITERALS.progress.items[0];

    expect(LiveItem.safeParse({ ...item, label: 'x'.repeat(LIVE_ITEM_LABEL_MAX) }).success).toBe(
      true,
    );
    expect(
      LiveItem.safeParse({ ...item, label: 'x'.repeat(LIVE_ITEM_LABEL_MAX + 1) }).success,
    ).toBe(false);
  });

  it('accepts every kind × state with counted or uncounted units', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('fill', 'artifact', 'effects', 'deliverable'),
        fc.constantFrom('pending', 'advancing', 'met'),
        fc.option(fc.nat(1000)),
        fc.option(fc.nat(1000)),
        (kind, state, done, total) => {
          const item = { id: 'item', kind, label: 'label', state, done, total };
          expect(LiveItem.parse(item)).toEqual(item);
        },
      ),
    );
  });
});
