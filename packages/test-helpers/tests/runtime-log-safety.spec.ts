import { describe, expect, it } from 'vitest';

import { assertRuntimeEventIsSafe } from '../src/runtime-log-safety.js';

describe('@no-llm runtime log safety / closed cause tokens', () => {
  it('accepts a closed cause token on a tool_failure line', () => {
    for (const cause of ['anomaly-challenge', 'budget:navigations', 'unexpected:TypeError']) {
      expect(() =>
        assertRuntimeEventIsSafe({ event: 'tool_failure', tool: 'web_search', code: 'X', cause }),
      ).not.toThrow();
    }
  });

  it('still rejects a serialized error or prose under cause', () => {
    expect(() => assertRuntimeEventIsSafe({ cause: { message: 'boom' } })).toThrow(
      /forbidden key "cause"/,
    );
    expect(() => assertRuntimeEventIsSafe({ cause: 'the provider said no' })).toThrow(/cause/);
    expect(() => assertRuntimeEventIsSafe({ cause: 'https://site.example/x' })).toThrow(/cause/);
    expect(() => assertRuntimeEventIsSafe({ cause: 'x'.repeat(81) })).toThrow(/cause/);
  });

  it('keeps canary scanning on a legal cause value', () => {
    expect(() => assertRuntimeEventIsSafe({ cause: 'leak-CANARY1' }, ['CANARY1'])).toThrow(
      /canary/,
    );
  });
});
