import { describe, expect, it } from 'vitest';

import {
  ContentIdentitySchema,
  ExecutionReceiptSchema,
  SettingSourceSchema,
} from '../src/schemas/execution-receipt.js';

const receipt = {
  schema_version: 1,
  run_id: 'fixture',
  sequence: 0,
  written_at: '2026-11-06T00:00:00.000Z',
  yantra_version: '0.0.1',
  invoked_by: 'worker',
  invocation_id: null,
  command: ['research'],
  cwd: 'C:/fixture',
  settings: [{ key: 'depth', value: 2, source: { kind: 'flag' } }],
  content: [],
  browser: null,
};
describe('execution receipt schema', () => {
  it('round trips a strict receipt', () => {
    expect(ExecutionReceiptSchema.parse(receipt)).toEqual(receipt);
  });
  it('requires the environment variable name and rejects values on its source', () => {
    expect(SettingSourceSchema.safeParse({ kind: 'env' }).success).toBe(false);
    expect(
      SettingSourceSchema.safeParse({ kind: 'env', name: 'YANTRA_AGENT_MODEL', value: 'secret' })
        .success,
    ).toBe(false);
    expect(SettingSourceSchema.parse({ kind: 'env', name: 'YANTRA_AGENT_MODEL' })).toEqual({
      kind: 'env',
      name: 'YANTRA_AGENT_MODEL',
    });
  });
  it.each(['ABCDEF', 'f'.repeat(63), 'G'.repeat(64)])('rejects malformed SHA-256 %s', (sha256) => {
    expect(
      ContentIdentitySchema.safeParse({ kind: 'workflow', path: '/fixture.yaml', sha256 }).success,
    ).toBe(false);
  });
  it('rejects relative paths, negative sequences and undeclared payload fields', () => {
    for (const change of [{ cwd: 'relative' }, { sequence: -1 }, { env: { SECRET: 'canary' } }])
      expect(ExecutionReceiptSchema.safeParse({ ...receipt, ...change }).success).toBe(false);
  });
});
