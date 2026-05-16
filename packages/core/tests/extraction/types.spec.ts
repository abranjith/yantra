import { describe, expect, it } from 'vitest';

import { cacheKey } from '../../src/extraction/cache-key.js';

describe('@no-llm extraction/types helpers', () => {
  it('produces a sha256-like cache key', () => {
    const key = cacheKey('ai news', 'browser', '2026-05-11');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
