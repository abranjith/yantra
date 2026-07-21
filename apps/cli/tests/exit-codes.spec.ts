import { describe, expect, it } from 'vitest';

import { EXIT, exitCodeFor, type CommandOutcome } from '../src/exit-codes.js';

describe('@no-llm cli/exit-codes', () => {
  it('maps every CommandOutcome kind to its documented exit code', () => {
    const cases: [CommandOutcome, number][] = [
      [{ kind: 'ok' }, EXIT.OK],
      [{ kind: 'validation_error', message: 'bad flag' }, EXIT.VALIDATION],
      [{ kind: 'execution_failure', message: 'run failed' }, EXIT.EXECUTION_FAILURE],
      [
        { kind: 'environment_failure', message: 'missing chrome', remediation: 'run doctor' },
        EXIT.ENVIRONMENT_FAILURE,
      ],
      [{ kind: 'user_handoff_abort', reason: 'captcha' }, EXIT.USER_HANDOFF],
    ];

    for (const [outcome, expected] of cases) {
      expect(exitCodeFor(outcome)).toBe(expected);
    }
  });

  it('uses the documented numeric exit codes', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.VALIDATION).toBe(1);
    expect(EXIT.EXECUTION_FAILURE).toBe(2);
    expect(EXIT.ENVIRONMENT_FAILURE).toBe(3);
    expect(EXIT.USER_HANDOFF).toBe(4);
  });
});
