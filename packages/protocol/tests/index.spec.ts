import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, SCHEMA_VERSION, parseSchemaVersion } from '../src/index.js';

describe('@no-llm protocol smoke', () => {
  it('exports a PROTOCOL_VERSION constant matching the package version', () => {
    expect(PROTOCOL_VERSION).toBe('0.0.0');
  });

  it('exports schema version v0.1 and parses it successfully', () => {
    expect(SCHEMA_VERSION).toBe('0.1');
    const parsed = parseSchemaVersion('0.1');
    expect(parsed.isOk).toBe(true);
  });

  it('exposes PROTOCOL_VERSION as a readonly string literal', () => {
    expect(typeof PROTOCOL_VERSION).toBe('string');
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
