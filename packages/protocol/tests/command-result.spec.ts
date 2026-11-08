import { describe, expect, it } from 'vitest';

import { CommandResultMessageSchema } from '../src/schemas/command-result.js';

describe('worker command results', () => {
  it.each([0, 1, 2, 3, 4, 130])('round trips supported exit %s', (code) => {
    const value = { type: 'result', exit_code: code, envelope: { status: 'fixture' }, text: null };
    expect(CommandResultMessageSchema.parse(value)).toEqual(value);
  });
  it.each([-1, 5, 129, 131, 1.5])('rejects unsupported exit %s', (code) => {
    expect(
      CommandResultMessageSchema.safeParse({
        type: 'result',
        exit_code: code,
        envelope: null,
        text: null,
      }).success,
    ).toBe(false);
  });
  it('allows cancellation errors and rejects extra payload keys', () => {
    expect(
      CommandResultMessageSchema.safeParse({
        type: 'error',
        exit_code: 130,
        code: 'aborted',
        message: 'cancelled',
        remediation: null,
      }).success,
    ).toBe(true);
    expect(
      CommandResultMessageSchema.safeParse({
        type: 'result',
        exit_code: 0,
        envelope: null,
        text: null,
        secret: 'canary',
      }).success,
    ).toBe(false);
  });
});
