import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { RobotsCacheImpl } from '../../src/ethics/robots.ts';

// We mock global fetch to avoid real network calls in unit tests.
// The actual robots-parser integration is covered by ethics-gate.spec.ts.

describe('@no-llm RobotsCacheImpl', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRobotsTxt = (disallowed: string[] = []) => {
    const rules = disallowed.map((p) => `Disallow: ${p}`).join('\n');
    return `User-agent: *\n${rules}`;
  };

  const mockFetch = (status: number, body: string) => {
    vi.mocked(fetch).mockResolvedValue({
      status,
      text: () => Promise.resolve(body),
    } as unknown as Response);
  };

  it('allows a URL when robots.txt has no restrictions', async () => {
    mockFetch(200, makeRobotsTxt([]));

    const cache = new RobotsCacheImpl('TestBot/1.0');
    const allowed = await cache.isAllowed('https://example.com/page', 'TestBot/1.0');
    expect(allowed).toBe(true);
  });

  it('disallows a URL when robots.txt blocks it', async () => {
    mockFetch(200, makeRobotsTxt(['/private/']));

    const cache = new RobotsCacheImpl('TestBot/1.0');
    const allowed = await cache.isAllowed('https://example.com/private/data', 'TestBot/1.0');
    expect(allowed).toBe(false);
  });

  it('fail-open on HTTP 404 (RFC 9309: no restrictions)', async () => {
    mockFetch(404, '');

    const cache = new RobotsCacheImpl('TestBot/1.0');
    const allowed = await cache.isAllowed('https://example.com/anything', 'TestBot/1.0');
    expect(allowed).toBe(true);
  });

  it('fail-closed on HTTP 500', async () => {
    mockFetch(500, 'Server Error');

    const cache = new RobotsCacheImpl('TestBot/1.0');
    const allowed = await cache.isAllowed('https://example.com/anything', 'TestBot/1.0');
    expect(allowed).toBe(false);
  });

  it('fail-closed when fetch throws (network error)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    const cache = new RobotsCacheImpl('TestBot/1.0');
    const allowed = await cache.isAllowed('https://example.com/anything', 'TestBot/1.0');
    expect(allowed).toBe(false);
  });

  it('caches robots.txt per host (only fetches once)', async () => {
    mockFetch(200, makeRobotsTxt([]));

    const cache = new RobotsCacheImpl('TestBot/1.0');
    await cache.isAllowed('https://example.com/a', 'TestBot/1.0');
    await cache.isAllowed('https://example.com/b', 'TestBot/1.0');
    await cache.isAllowed('https://example.com/c', 'TestBot/1.0');

    // fetch should have been called exactly once for https://example.com/robots.txt
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('fetches separately for different hosts', async () => {
    mockFetch(200, makeRobotsTxt([]));

    const cache = new RobotsCacheImpl('TestBot/1.0');
    await cache.isAllowed('https://a.com/page', 'TestBot/1.0');
    await cache.isAllowed('https://b.com/page', 'TestBot/1.0');

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('reasonIfDisallowed returns null when allowed', async () => {
    mockFetch(200, makeRobotsTxt([]));

    const cache = new RobotsCacheImpl('TestBot/1.0');
    const reason = await cache.reasonIfDisallowed('https://example.com/page', 'TestBot/1.0');
    expect(reason).toBeNull();
  });

  it('reasonIfDisallowed returns a descriptive string when disallowed', async () => {
    mockFetch(200, makeRobotsTxt(['/']));

    const cache = new RobotsCacheImpl('TestBot/1.0');
    const reason = await cache.reasonIfDisallowed('https://example.com/page', 'TestBot/1.0');
    expect(reason).toBeTypeOf('string');
    expect(reason).toContain('example.com');
  });
});
