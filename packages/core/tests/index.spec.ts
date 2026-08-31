import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../src/index.js';

describe('@no-llm core smoke', () => {
  it('re-exports the protocol version through the core boundary', () => {
    expect(PROTOCOL_VERSION).toBe('0.0.1');
  });
});
