import { describe, expect, it } from 'vitest';

import {
  AGENT_DURATION_PATTERN,
  formatAgentDuration,
  parseAgentCount,
  parseAgentDurationMs,
} from '../../src/profile/agent-budgets.js';
import { profileSchema, validatePreference } from '../../src/profile/profile-file.js';

describe('@no-llm agent budget grammar', () => {
  it.each([
    ['5', 5],
    ['5ms', 5],
    ['900s', 900_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['900000', 900_000],
    ['  15m  ', 900_000],
  ])('parses duration %j as %i ms', (raw, expected) => {
    expect(parseAgentDurationMs(raw)).toBe(expected);
  });

  it.each(['', '   ', 'abc', '-5m', '5x', '1.5m', '0', '0s', '05m', 'soon', '1e3'])(
    'rejects duration %j',
    (raw) => {
      expect(parseAgentDurationMs(raw)).toBeNull();
    },
  );

  it.each([null, undefined, {}, [], true])('rejects non-scalar duration %j', (raw) => {
    expect(parseAgentDurationMs(raw)).toBeNull();
  });

  it('rejects a duration that cannot be represented as a safe integer', () => {
    expect(parseAgentDurationMs('99999999999999h')).toBeNull();
  });

  it.each([
    ['5', 5],
    [5, 5],
    ['  7  ', 7],
    ['2000000', 2_000_000],
  ])('parses count %j as %i', (raw, expected) => {
    expect(parseAgentCount(raw, { allowZero: false })).toBe(expected);
  });

  it.each(['', '  ', 'abc', '-1', '1.5', '1e3', 'Infinity', null, undefined, {}])(
    'rejects count %j',
    (raw) => {
      expect(parseAgentCount(raw, { allowZero: true })).toBeNull();
    },
  );

  it('treats zero as legal only when the caller allows it', () => {
    expect(parseAgentCount('0', { allowZero: true })).toBe(0);
    expect(parseAgentCount('0', { allowZero: false })).toBeNull();
    expect(parseAgentCount(0, { allowZero: true })).toBe(0);
    expect(parseAgentCount(0, { allowZero: false })).toBeNull();
  });

  it('does not let an empty string coerce to zero', () => {
    // `Number('')` is 0, so an unset environment variable would silently
    // become a zero budget under a naive parse.
    expect(parseAgentCount('', { allowZero: true })).toBeNull();
  });

  it.each([
    [7_200_000, '2h'],
    [900_000, '15m'],
    [90_000, '90s'],
    [1_500, '1500ms'],
  ])('formats %i ms as %s', (milliseconds, expected) => {
    expect(formatAgentDuration(milliseconds)).toBe(expected);
  });

  it('round-trips every formatted duration back through the parser', () => {
    for (const milliseconds of [1, 999, 1_000, 90_000, 900_000, 3_600_000, 7_200_000]) {
      expect(parseAgentDurationMs(formatAgentDuration(milliseconds))).toBe(milliseconds);
    }
  });

  it('is the same grammar the profile schema enforces', () => {
    // One grammar, one source. If these ever disagree, a value `profile.yaml`
    // accepts becomes a value the runtime cannot parse.
    for (const candidate of ['15m', '900s', '900000', 'soon', '1.5m', '0', '']) {
      const schemaAccepts = profileSchema.safeParse({
        agent: { max_duration: candidate },
      }).success;
      expect(schemaAccepts).toBe(AGENT_DURATION_PATTERN.test(candidate));
      expect(schemaAccepts).toBe(parseAgentDurationMs(candidate) !== null);
    }
  });

  it('rejects the same durations through the single-preference validator', () => {
    expect(validatePreference('agent.max_duration', '15m').isOk).toBe(true);
    expect(validatePreference('agent.max_duration', 'soon').isOk).toBe(false);
  });
});
