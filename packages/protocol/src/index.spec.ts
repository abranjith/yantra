import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from './index.js';

describe('@no-llm protocol smoke', () => {
  it('exports a PROTOCOL_VERSION constant matching the package version', () => {
    expect(PROTOCOL_VERSION).toBe('0.0.0');
  });

  it('exposes PROTOCOL_VERSION as a readonly string literal', () => {
    expect(typeof PROTOCOL_VERSION).toBe('string');
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
