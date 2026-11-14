// @no-llm
/**
 * Registry data the app composer shares with the CLI (FEAT-067): the duration
 * grammar and its words, the app option exemptions, the dead-option list.
 */

import { describe, expect, it } from 'vitest';

import { KNOWN_DEAD_OPTIONS, isKnownDeadOption } from '../../src/commands/dead-options.js';
import {
  AGENT_DURATION_PATTERN,
  durationProblem,
  parseAgentDurationMs,
} from '../../src/commands/duration.js';
import { expandOptions } from '../../src/commands/expand.js';
import { APP_OPTION_EXEMPTIONS, isAppExemptOption } from '../../src/commands/presentation.js';
import { COMMAND_REGISTRY, findLeaf } from '../../src/commands/registry.js';

describe('duration grammar', () => {
  it.each([
    ['15m', 900_000],
    ['900s', 900_000],
    ['900000', 900_000],
    [' 2h ', 7_200_000],
    ['250ms', 250],
  ])('parses %s', (raw, ms) => {
    expect(parseAgentDurationMs(raw)).toBe(ms);
    expect(durationProblem(raw, '--max-duration')).toBeNull();
  });

  it.each(['0', '-5m', '1.5m', 'soon', '5d', '', '15 m'])(
    'refuses %j in the CLI’s words',
    (raw) => {
      expect(parseAgentDurationMs(raw)).toBeNull();
      expect(durationProblem(raw, '--max-duration')).toBe(
        '--max-duration must be a positive duration such as 15m, 900s, or 900000.',
      );
    },
  );

  it('names a value too large to hold in milliseconds separately', () => {
    expect(AGENT_DURATION_PATTERN.test('99999999999h')).toBe(true);
    expect(durationProblem('99999999999h', '--tool-timeout')).toBe(
      '--tool-timeout is too large to represent safely in milliseconds.',
    );
  });
});

describe('app option exemptions', () => {
  it('give a reason for each exempt flag, and every flag is registered somewhere', () => {
    const flags = new Set(
      COMMAND_REGISTRY.commands.flatMap((entry) =>
        entry.kind === 'leaf'
          ? expandOptions(entry, COMMAND_REGISTRY.option_groups).map((spec) => spec.long)
          : [],
      ),
    );
    for (const exemption of APP_OPTION_EXEMPTIONS) {
      expect(exemption.reason.length).toBeGreaterThan(10);
      expect(flags.has(exemption.long)).toBe(true);
    }
    expect(APP_OPTION_EXEMPTIONS.map((item) => item.long)).toEqual([
      '--json',
      '--open',
      '--no-color',
    ]);
  });

  it('answers by long flag', () => {
    expect(isAppExemptOption('--json')).toBe(true);
    expect(isAppExemptOption('--no-llm')).toBe(false);
  });
});

describe('known dead options', () => {
  it('name registered options of registered commands', () => {
    for (const dead of KNOWN_DEAD_OPTIONS) {
      const entry = findLeaf(dead.command.split('.'));
      expect(entry).toBeDefined();
      const flags = expandOptions(entry!, COMMAND_REGISTRY.option_groups).map((spec) => spec.long);
      expect(flags).toContain(dead.option);
    }
  });

  it('answer by command and flag', () => {
    expect(isKnownDeadOption('run', '--template')).toBe(true);
    expect(isKnownDeadOption('ask', '--template')).toBe(false);
  });
});
