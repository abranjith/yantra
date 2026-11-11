// @no-llm
/**
 * Run-channel messages and the worker launch/result files (FEAT-064 TASK-002).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_VERSION,
  FRAME_HEADER_BYTES,
  FRAME_TYPE_JSON,
  FRAME_TYPE_SCREENCAST,
  MAX_HELLO_FRAME_BYTES,
  MAX_JSON_FRAME_BYTES,
  MAX_SCREENCAST_FRAME_BYTES,
  RunChannelClientMessage,
  RunChannelEventPayload,
  RunChannelMessage,
  RunChannelServerMessage,
  SUPPORTED_CHANNEL_VERSIONS,
  WorkerLaunch,
  WorkerResult,
} from '../src/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'run-events');

function fixtureEvent(name: string): Record<string, unknown> {
  const record = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as {
    event: Record<string, unknown>;
  };
  return record.event;
}

const RUN_OUTCOME = fixtureEvent('new-values/run_outcome.json');
const UNKNOWN_KIND = fixtureEvent('newer-writer.unknown-kind.json');

describe('@no-llm run-channel constants', () => {
  it('pins the framing grammar and limits from plan §6', () => {
    expect([FRAME_TYPE_JSON, FRAME_TYPE_SCREENCAST, FRAME_HEADER_BYTES]).toEqual([1, 2, 5]);
    expect(MAX_JSON_FRAME_BYTES).toBe(1024 * 1024);
    expect(MAX_SCREENCAST_FRAME_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_HELLO_FRAME_BYTES).toBe(16 * 1024);
  });

  it('speaks version 1 and supports exactly 1..1', () => {
    expect(CHANNEL_VERSION).toBe(1);
    expect(SUPPORTED_CHANNEL_VERSIONS).toEqual({ min: 1, max: 1 });
  });
});

describe('@no-llm RunChannelClientMessage', () => {
  it.each([
    [
      'hello',
      {
        type: 'hello',
        token: 'x'.repeat(43),
        channel_version: 1,
        capabilities: ['events'],
        client_kind: 'host',
      },
    ],
    ['subscribe from 0', { type: 'subscribe', from_seq: 0 }],
    ['subscribe from 401', { type: 'subscribe', from_seq: 401 }],
    ['cancel', { type: 'cancel' }],
    ['ping', { type: 'ping' }],
  ])('parses %s unchanged', (_label, message) => {
    expect(RunChannelClientMessage.parse(message)).toEqual(message);
  });

  it('parses an unknown type as passthrough, keeping its fields', () => {
    const message = { type: 'intervention.answer', intervention_id: 'c1', decision: 'grant' };
    expect(RunChannelClientMessage.parse(message)).toEqual(message);
  });

  it.each([
    [
      'hello without token',
      { type: 'hello', channel_version: 1, capabilities: [], client_kind: 'cli' },
    ],
    [
      'hello with an empty token',
      { type: 'hello', token: '', channel_version: 1, capabilities: [], client_kind: 'cli' },
    ],
    [
      'hello with an unknown client kind',
      { type: 'hello', token: 't', channel_version: 1, capabilities: [], client_kind: 'app' },
    ],
    [
      'hello with a negative version',
      { type: 'hello', token: 't', channel_version: -1, capabilities: [], client_kind: 'cli' },
    ],
    ['subscribe with a negative from_seq', { type: 'subscribe', from_seq: -1 }],
    ['subscribe without from_seq', { type: 'subscribe' }],
    ['cancel with an extra key', { type: 'cancel', force: true }],
    ['a message without type', { from_seq: 1 }],
    ['an empty type', { type: '' }],
  ])('rejects %s', (_label, message) => {
    expect(RunChannelClientMessage.safeParse(message).success).toBe(false);
  });
});

describe('@no-llm RunChannelServerMessage', () => {
  it.each([
    [
      'hello_ok',
      {
        type: 'hello_ok',
        channel_version: 1,
        supported: { min: 1, max: 1 },
        capabilities: ['events', 'cancel'],
        run_id: 'r1',
      },
    ],
    [
      'hello_incompatible',
      { type: 'hello_incompatible', supported: { min: 2, max: 3 }, yantra_version: '0.2.0' },
    ],
    ['event with a known kind', { type: 'event', seq: 23, event: RUN_OUTCOME }],
    ['event with a kind from a newer owner', { type: 'event', seq: 7, event: UNKNOWN_KIND }],
    ['event_oversize', { type: 'event_oversize', seq: 9 }],
    ['heartbeat', { type: 'heartbeat', at: '2026-11-09T12:00:00.000Z' }],
    ['cancel_ack', { type: 'cancel_ack', already_cancelling: false, honored: false }],
    ['error', { type: 'error', code: 'unsupported', message: 'intervention.answer' }],
  ])('parses %s unchanged', (_label, message) => {
    expect(RunChannelServerMessage.parse(message)).toEqual(message);
  });

  it('parses an unknown type as passthrough (later frame-control messages need no version bump)', () => {
    const message = { type: 'frames.cleared', generation: 3 };
    expect(RunChannelServerMessage.parse(message)).toEqual(message);
  });

  it.each([
    [
      'an event whose known kind fails validation',
      { type: 'event', seq: 1, event: { kind: 'run_outcome' } },
    ],
    ['an event with seq 0', { type: 'event', seq: 0, event: RUN_OUTCOME }],
    ['an event without a kind', { type: 'event', seq: 1, event: { at: 'x' } }],
    ['an unknown error code', { type: 'error', code: 'teapot', message: '' }],
    ['cancel_ack without honored', { type: 'cancel_ack', already_cancelling: true }],
    ['a heartbeat with a bad time', { type: 'heartbeat', at: 'now' }],
    [
      'hello_ok with version 0',
      {
        type: 'hello_ok',
        channel_version: 0,
        supported: { min: 1, max: 1 },
        capabilities: [],
        run_id: 'r',
      },
    ],
  ])('rejects %s', (_label, message) => {
    expect(RunChannelServerMessage.safeParse(message).success).toBe(false);
  });
});

describe('@no-llm RunChannelEventPayload', () => {
  it('validates a known kind strictly and lets an unknown kind through', () => {
    expect(RunChannelEventPayload.safeParse(RUN_OUTCOME).success).toBe(true);
    expect(RunChannelEventPayload.safeParse(UNKNOWN_KIND).success).toBe(true);
    expect(RunChannelEventPayload.safeParse({ ...RUN_OUTCOME, exit_code: 'zero' }).success).toBe(
      false,
    );
  });
});

describe('@no-llm RunChannelMessage', () => {
  it('accepts messages in either direction', () => {
    expect(RunChannelMessage.safeParse({ type: 'ping' }).success).toBe(true);
    expect(RunChannelMessage.safeParse({ type: 'event_oversize', seq: 2 }).success).toBe(true);
  });
});

const INVOCATION = {
  invocation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: ['research'],
  argv: ['--no-llm', 'compare espresso grinders'],
  cwd: process.platform === 'win32' ? 'C:\\Users\\u' : '/home/u',
};
const RESULT_PATH =
  process.platform === 'win32'
    ? 'C:\\Users\\u\\.yantra\\data\\ui\\launch\\01ARZ3NDEKTSV4RRFFQ69G5FAV.result.json'
    : '/home/u/.yantra/data/ui/launch/01ARZ3NDEKTSV4RRFFQ69G5FAV.result.json';

describe('@no-llm WorkerLaunch', () => {
  it('round-trips with and without a preallocated run ID', () => {
    const base = { schema_version: 1, invocation: INVOCATION, result_path: RESULT_PATH };
    expect(WorkerLaunch.parse(base)).toEqual(base);
    expect(WorkerLaunch.parse({ ...base, run_id: 'r1' })).toEqual({ ...base, run_id: 'r1' });
  });

  it.each([
    ['a relative result path', { result_path: 'launch/x.result.json' }],
    ['an invocation with a relative cwd', { invocation: { ...INVOCATION, cwd: 'here' } }],
    ['an invocation with a bad ID', { invocation: { ...INVOCATION, invocation_id: 'abc' } }],
    ['an empty run ID', { run_id: '' }],
    ['schema_version 2', { schema_version: 2 }],
    ['an extra key', { env: { ANTHROPIC_API_KEY: 'x' } }],
  ])('rejects %s', (_label, change) => {
    const base = { schema_version: 1, invocation: INVOCATION, result_path: RESULT_PATH };
    expect(WorkerLaunch.safeParse({ ...base, ...change }).success).toBe(false);
  });
});

describe('@no-llm WorkerResult', () => {
  it('carries either completion shape of the command result transport', () => {
    const result = {
      schema_version: 1,
      invocation_id: INVOCATION.invocation_id,
      run_id: 'r1',
      outcome: { type: 'result', exit_code: 0, envelope: null, text: null },
    };
    const error = {
      schema_version: 1,
      invocation_id: INVOCATION.invocation_id,
      outcome: {
        type: 'error',
        exit_code: 1,
        code: 'WORKER_CLASS_REFUSED',
        message: 'secret set does not run on a worker',
        remediation: null,
      },
    };
    expect(WorkerResult.parse(result)).toEqual(result);
    expect(WorkerResult.parse(error)).toEqual(error);
  });

  it('rejects an outcome outside the transport shape', () => {
    expect(
      WorkerResult.safeParse({
        schema_version: 1,
        invocation_id: 'x',
        outcome: { type: 'result', exit_code: 7, envelope: null, text: null },
      }).success,
    ).toBe(false);
  });
});
