import { AGENT_PROTOCOL_VERSION } from '@yantra/agent';
import { CORE_PROTOCOL_VERSION } from '@yantra/core';
import { PROTOCOL_VERSION } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

describe('@no-llm e2e cross-package smoke', () => {
  it('every workspace boundary reports the same protocol version', () => {
    expect(PROTOCOL_VERSION).toBe('0.0.0');
    expect(CORE_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
    expect(AGENT_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });
});
