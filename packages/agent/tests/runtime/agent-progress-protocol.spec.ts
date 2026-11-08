// @no-llm
/**
 * `AgentProgressEvent` is protocol data (FEAT-063 TASK-003): `@yantra/agent`
 * re-exports the protocol type rather than declaring its own, and every
 * variant the orchestrator emits parses under the protocol schema unchanged.
 */
import {
  AgentProgressEvent as ProtocolAgentProgressSchema,
  type AgentProgressEvent as ProtocolAgentProgressEvent,
  type LiveItem as ProtocolLiveItem,
} from '@yantra/protocol';
import { CONTRACT_SUMMARY_MAX } from '@yantra/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AgentProgressEvent } from '../../src/index.js';
import type { AgentTaskConnector } from '../../src/runtime/connector.js';
import { capabilityGapLine } from '../../src/runtime/contract-capabilities.js';
import { renderProgressLine, type LiveItem } from '../../src/runtime/progress-ledger.js';
import { CONTRACT_ECHO_MAX } from '../../src/runtime/task-contract.js';

const at = '2026-11-01T00:00:00.000Z';

describe('@no-llm AgentProgressEvent is the protocol type', () => {
  it('is identical to the protocol type, and so is LiveItem', () => {
    expectTypeOf<AgentProgressEvent>().toEqualTypeOf<ProtocolAgentProgressEvent>();
    expectTypeOf<LiveItem>().toEqualTypeOf<ProtocolLiveItem>();
    expectTypeOf<
      Parameters<AgentTaskConnector['emitAgentEvent']>[0]
    >().toEqualTypeOf<ProtocolAgentProgressEvent>();
  });

  it('keeps the agent contract-echo bound equal to the protocol bound', () => {
    expect(CONTRACT_ECHO_MAX).toBe(CONTRACT_SUMMARY_MAX);
  });

  it('parses every variant, built as the orchestrator builds it, unchanged', () => {
    const items: LiveItem[] = [
      {
        id: 'fill:email',
        kind: 'fill',
        label: 'email'.padEnd(80, '.').slice(0, 60),
        state: 'met',
        done: 1,
        total: 1,
      },
      {
        id: 'effects',
        kind: 'effects',
        label: 'submit',
        state: 'advancing',
        done: null,
        total: null,
      },
    ];
    const emitted: AgentProgressEvent[] = [
      {
        type: 'recovery',
        rung: 'stop',
        trigger: 'stalled',
        move: null,
        summary: 'still no progress; run stopped',
        at,
      },
      { type: 'progress', items, summary: renderProgressLine(items), at },
      { type: 'assistant_text', text: 'chunk\twith\ncontrol', at },
      { type: 'tool_started', tool: 'web_fetch', summary: 'fields: url, mode', at },
      {
        type: 'tool_finished',
        tool: 'web_fetch',
        summary: 'ok',
        status: 'ok',
        durationMs: 42,
        at,
      },
      { type: 'contract_declared', revision: 1, summary: 'x'.repeat(CONTRACT_ECHO_MAX), at },
      {
        type: 'capability_gap',
        item: 'artifact:screenshot:viewport',
        reason: 'no_browser',
        summary: capabilityGapLine('viewport', 'no_browser'),
        at,
      },
    ];

    for (const event of emitted) {
      const parsed = ProtocolAgentProgressSchema.parse(event);
      expect(parsed).toEqual(event);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(event));
    }
  });
});
