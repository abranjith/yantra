// @no-llm
/**
 * App host records (FEAT-065 TASK-001): `host.lock`, invocation records and
 * the displayed-effective baseline that queue drift review compares against.
 */

import { describe, expect, it } from 'vitest';

import {
  DisplayedEffective,
  HostLockRecord,
  INVOCATION_ID_PATTERN,
  InvocationRecord,
  InvocationResult,
  InvocationState,
  UiOpenResult,
  WorkerResult,
  displayedEffectiveSchema,
  secretSettingKeys,
} from '../src/index.js';

const TOKEN = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';
const ULID = '01JD2X7Q8R9S0T1V2W3X4Y5Z6A';
const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
const SHA = 'a'.repeat(64);

function hostLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    state: 'ready',
    pid: 4242,
    start_token: '133780000000000000',
    port: 51_234,
    control_socket: '\\\\.\\pipe\\yantra-host-0123',
    control_token: TOKEN,
    build_id: 'b'.repeat(64),
    yantra_version: '0.0.1',
    channel_version: 1,
    started_at: '2026-11-11T10:00:00.000Z',
    env_captured_at: '2026-11-11T10:00:00.000Z',
    ...overrides,
  };
}

function invocationRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    invocation_id: ULID,
    invocation: { invocation_id: ULID, path: ['research'], argv: ['--no-llm', 'q'], cwd: CWD },
    execution_class: 'run',
    state: 'queued',
    queued_at: '2026-11-11T10:00:00.000Z',
    updated_at: '2026-11-11T10:00:00.000Z',
    displayed_effective: {
      settings: [{ key: 'detail', value: 'standard', source: { kind: 'default' } }],
      content: [{ kind: 'workflow', path: CWD, sha256: SHA }],
    },
    run_id: null,
    worker: null,
    review: null,
    duplicate_risk_acknowledged: false,
    result: null,
    ...overrides,
  };
}

describe('HostLockRecord', () => {
  it('round-trips a ready record unchanged', () => {
    // Arrange
    const input = hostLock();

    // Act
    const parsed = HostLockRecord.parse(JSON.parse(JSON.stringify(input)));

    // Assert
    expect(parsed).toEqual(input);
  });

  it('accepts a starting record with no port or socket yet', () => {
    expect(
      HostLockRecord.safeParse(hostLock({ state: 'starting', port: null, control_socket: null }))
        .success,
    ).toBe(true);
  });

  it('refuses a ready record without a port', () => {
    expect(HostLockRecord.safeParse(hostLock({ port: null })).success).toBe(false);
  });

  it.each([
    ['a short control token', { control_token: 'short' }],
    ['a zero port', { port: 0 }],
    ['a port over 65535', { port: 65_536 }],
    ['an unknown state', { state: 'stopping' }],
    ['an extra field', { extra: true }],
    ['schema version 2', { schema_version: 2 }],
  ])('refuses %s', (_label, overrides) => {
    expect(HostLockRecord.safeParse(hostLock(overrides)).success).toBe(false);
  });
});

describe('InvocationRecord', () => {
  it('round-trips a queued record unchanged', () => {
    const input = invocationRecord();
    expect(InvocationRecord.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  it('round-trips a finished record with a worker, run ID and reason', () => {
    const input = invocationRecord({
      state: 'finished',
      run_id: '20261111T100000Z-research-0000abcd',
      worker: { pid: 77, start_token: 'tok' },
      result: { exit_code: 2, finished_at: '2026-11-11T10:05:00.000Z', reason: 'owner_lost' },
    });
    expect(InvocationRecord.parse(input)).toEqual(input);
  });

  it('defaults duplicate_risk_acknowledged to false', () => {
    const { duplicate_risk_acknowledged: _omit, ...rest } = invocationRecord();
    expect(InvocationRecord.parse(rest).duplicate_risk_acknowledged).toBe(false);
  });

  it('carries a review with its differences', () => {
    const review = {
      detected_at: '2026-11-11T10:01:00.000Z',
      differences: [{ key: 'detail', submitted: 'standard', current: 'deep', pinnable: true }],
    };
    const parsed = InvocationRecord.parse(invocationRecord({ state: 'needs_review', review }));
    expect(parsed.review).toEqual(review);
  });

  it('refuses a review with no differences', () => {
    const review = { detected_at: '2026-11-11T10:01:00.000Z', differences: [] };
    expect(InvocationRecord.safeParse(invocationRecord({ review })).success).toBe(false);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['with a slash', `${'a'.repeat(20)}/x`],
    ['with a dot', `${'a'.repeat(20)}..`],
    ['empty', ''],
  ])('refuses a malformed invocation_id (%s)', (_label, id) => {
    expect(InvocationRecord.safeParse(invocationRecord({ invocation_id: id })).success).toBe(false);
  });

  it('refuses an invocation_id that differs from the invocation it records', () => {
    const other = '01JD2X7Q8R9S0T1V2W3X4Y5Z6B';
    expect(InvocationRecord.safeParse(invocationRecord({ invocation_id: other })).success).toBe(
      false,
    );
  });

  it('refuses a relative cwd', () => {
    const invocation = { invocation_id: ULID, path: ['research'], argv: [], cwd: 'work/dir' };
    expect(InvocationRecord.safeParse(invocationRecord({ invocation })).success).toBe(false);
  });

  it.each(['read', 'exemption', 'adapter', 'in-process-secure'])(
    'refuses execution class %s, which never runs on a worker',
    (execution_class) => {
      expect(InvocationRecord.safeParse(invocationRecord({ execution_class })).success).toBe(false);
    },
  );

  it('refuses an unknown state', () => {
    expect(InvocationRecord.safeParse(invocationRecord({ state: 'paused' })).success).toBe(false);
  });

  it('refuses an unknown finish reason', () => {
    const result = { exit_code: 0, finished_at: '2026-11-11T10:05:00.000Z', reason: 'timeout' };
    expect(InvocationRecord.safeParse(invocationRecord({ result })).success).toBe(false);
  });

  it('lists exactly the ten D11 states', () => {
    expect(InvocationState.options).toEqual([
      'queued',
      'reserved',
      'spawning',
      'claimed',
      'running',
      'finished',
      'never_started',
      'start_unknown',
      'needs_review',
      'discarded',
    ]);
  });

  it('accepts a ULID under the invocation ID pattern', () => {
    expect(INVOCATION_ID_PATTERN.test(ULID)).toBe(true);
  });
});

describe('DisplayedEffective', () => {
  it('refuses a setting whose key is a registry secret input', () => {
    // Arrange
    const schema = displayedEffectiveSchema(new Set(['apiKey']));
    const value = {
      settings: [{ key: 'apiKey', value: 'sk-live-canary', source: { kind: 'flag' } }],
      content: [],
    };

    // Act
    const result = schema.safeParse(value);

    // Assert
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('sk-live-canary');
  });

  it('refuses the shipped registry secret input inside an invocation record', () => {
    const key = [...secretSettingKeys()][0];
    expect(key).toBeDefined();
    const displayed_effective = {
      settings: [{ key, value: 'canary', source: { kind: 'flag' } }],
      content: [],
    };
    expect(InvocationRecord.safeParse(invocationRecord({ displayed_effective })).success).toBe(
      false,
    );
  });

  it('accepts env-sourced settings that carry the variable name only', () => {
    const value = {
      settings: [
        { key: 'provider', value: 'none', source: { kind: 'env', name: 'YANTRA_AGENT_PROVIDER' } },
      ],
      content: [],
    };
    expect(DisplayedEffective.safeParse(value).success).toBe(true);
  });

  it('refuses a content identity with a malformed hash', () => {
    const value = { settings: [], content: [{ kind: 'workflow', path: CWD, sha256: 'xyz' }] };
    expect(DisplayedEffective.safeParse(value).success).toBe(false);
  });
});

describe('InvocationResult', () => {
  it('is the FEAT-064 worker result', () => {
    expect(InvocationResult).toBe(WorkerResult);
  });
});

describe('UiOpenResult', () => {
  const open = {
    schemaVersion: 1,
    url: 'http://127.0.0.1:51234/#code=abc_DEF-123',
    port: 51_234,
    hostPid: 4242,
    reused: false,
  };

  it('round-trips', () => {
    expect(UiOpenResult.parse(open)).toEqual(open);
  });

  it.each([
    ['localhost', 'http://localhost:51234/#code=abc'],
    ['https', 'https://127.0.0.1:51234/#code=abc'],
    ['a code in the query', 'http://127.0.0.1:51234/?code=abc'],
    ['no code', 'http://127.0.0.1:51234/'],
  ])('refuses a URL with %s', (_label, url) => {
    expect(UiOpenResult.safeParse({ ...open, url }).success).toBe(false);
  });
});
