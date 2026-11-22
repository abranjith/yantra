// @no-llm
/**
 * REV-013 (GHSA-mrhx-c7xc-m3w5, interim until Zod 4): arrays a window or a
 * run-socket client can send are bounded. Each limit is accepted exactly and
 * refused one past it.
 */
import { describe, expect, it } from 'vitest';

import {
  BOUNDED_JSON_ARRAY_MAX,
  CHANNEL_CAPABILITIES_MAX,
  CommandInvocation,
  DISPLAYED_EFFECTIVE_MAX,
  DisplayedEffective,
  INVOCATION_ARGV_MAX,
  INVOCATION_PATH_MAX,
  JSON_RPC_PARAMS_ARRAY_MAX,
  JsonRpcRequest,
  RunChannelClientMessage,
} from '../src/index.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
const ID = '01JD2X7Q8R9S0T1V2W3X000001';

const invocation = (path: string[], argv: string[]) => ({
  invocation_id: ID,
  path,
  argv,
  cwd: CWD,
});

const setting = (value: unknown) => ({ key: 'agent.model', value, source: { kind: 'flag' } });

describe('@no-llm window and run-socket input bounds', () => {
  it.each([
    [
      'argv',
      invocation(
        ['do'],
        Array.from({ length: INVOCATION_ARGV_MAX }, () => 'x'),
      ),
      true,
    ],
    [
      'argv',
      invocation(
        ['do'],
        Array.from({ length: INVOCATION_ARGV_MAX + 1 }, () => 'x'),
      ),
      false,
    ],
    [
      'path',
      invocation(
        Array.from({ length: INVOCATION_PATH_MAX }, () => 'p'),
        [],
      ),
      true,
    ],
    [
      'path',
      invocation(
        Array.from({ length: INVOCATION_PATH_MAX + 1 }, () => 'p'),
        [],
      ),
      false,
    ],
  ])('CommandInvocation %s at its bound is accepted=%s', (_field, value, accepted) => {
    expect(CommandInvocation.safeParse(value).success).toBe(accepted);
  });

  it.each([
    [DISPLAYED_EFFECTIVE_MAX, true],
    [DISPLAYED_EFFECTIVE_MAX + 1, false],
  ])('DisplayedEffective with %i settings is accepted=%s', (count, accepted) => {
    const settings = Array.from({ length: count }, (_, index) => ({
      ...setting(index),
      key: `k${index}`,
    }));
    expect(DisplayedEffective.safeParse({ settings, content: [] }).success).toBe(accepted);
  });

  it.each([
    [BOUNDED_JSON_ARRAY_MAX, true],
    [BOUNDED_JSON_ARRAY_MAX + 1, false],
  ])('a displayed setting value with an inner array of %i is accepted=%s', (count, accepted) => {
    const value = { nested: Array.from({ length: count }, () => 1) };
    expect(DisplayedEffective.safeParse({ settings: [setting(value)], content: [] }).success).toBe(
      accepted,
    );
  });

  it.each([
    [JSON_RPC_PARAMS_ARRAY_MAX, true],
    [JSON_RPC_PARAMS_ARRAY_MAX + 1, false],
  ])('JSON-RPC positional params of %i is accepted=%s', (count, accepted) => {
    const request = { jsonrpc: '2.0', method: 'x', params: Array.from({ length: count }), id: 1 };
    expect(JsonRpcRequest.safeParse(request).success).toBe(accepted);
  });

  it.each([
    [CHANNEL_CAPABILITIES_MAX, true],
    [CHANNEL_CAPABILITIES_MAX + 1, false],
  ])('a run-socket hello with %i capabilities is accepted=%s', (count, accepted) => {
    const hello = {
      type: 'hello',
      token: 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg',
      channel_version: 1,
      capabilities: Array.from({ length: count }, (_, index) => `cap${index}`),
      client_kind: 'cli',
    };
    expect(RunChannelClientMessage.safeParse(hello).success).toBe(accepted);
  });
});
