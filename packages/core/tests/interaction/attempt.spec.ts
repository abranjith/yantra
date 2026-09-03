import { describe, expect, it } from 'vitest';

import { classifyFailure } from '../../src/interaction/attempt.js';

describe('@no-llm classifyFailure compatibility export', () => {
  it('classifies transient and terminal browser answers', () => {
    expect(classifyFailure('WIDGET_ELEMENT_REPLACED')).toBe('transient');
    expect(classifyFailure('WIDGET_AMBIGUOUS_CHOICE')).toBe('terminal');
    expect(classifyFailure('SOME_FUTURE_CODE')).toBe('terminal');
  });

  it('preserves reason and obstruction overrides', () => {
    expect(classifyFailure('WIDGET_NOT_COMMITTED', { reason: 'budget' })).toBe('terminal');
    expect(classifyFailure('ELEMENT_OBSTRUCTED', { kind: 'busy-indicator' })).toBe('transient');
    expect(classifyFailure('ELEMENT_OBSTRUCTED', { kind: 'modal' })).toBe('terminal');
  });
});
