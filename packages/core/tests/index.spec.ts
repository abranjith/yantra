import { describe, expect, it } from 'vitest';

import { CORE_PROTOCOL_VERSION } from '../src/index.js';

describe('@no-llm core smoke', () => {
  it('re-exports the protocol version through the core boundary', () => {
    expect(CORE_PROTOCOL_VERSION).toBe('0.0.0');
  });
});

