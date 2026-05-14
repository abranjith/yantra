import { describe, expect, it } from 'vitest';

import { AGENT_PROTOCOL_VERSION } from '../src/index.js';

describe('@no-llm agent smoke', () => {
  it('re-exports the protocol version through the agent boundary', () => {
    expect(AGENT_PROTOCOL_VERSION).toBe('0.0.0');
  });
});

