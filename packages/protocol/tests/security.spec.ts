import { describe, expect, it } from 'vitest';

import { ALLOWED_VERBS_BY_SCOPE, STEP_VERBS } from '../src/index.js';

describe('@no-llm security enums and scope table', () => {
  it('covers every known step verb in public and authenticated scopes', () => {
    expect(ALLOWED_VERBS_BY_SCOPE.public).toEqual(STEP_VERBS);
    expect(ALLOWED_VERBS_BY_SCOPE.authenticated).toEqual(STEP_VERBS);
  });

  it('keeps read-only-data scope to non-mutating verbs', () => {
    expect(ALLOWED_VERBS_BY_SCOPE['read-only-data']).toEqual([
      'extract',
      'wait_for',
      'llm_summarize',
    ]);
  });
});
