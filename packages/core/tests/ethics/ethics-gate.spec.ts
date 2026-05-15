import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { EthicsGateImpl } from '../../src/ethics/ethics-gate.js';
import { BlocklistImpl } from '../../src/ethics/blocklist.js';
import { RobotsCacheImpl } from '../../src/ethics/robots.ts';
import { RateLimiterImpl } from '../../src/ethics/rate-limiter.js';
import { EthicsRefusedError } from '../../src/executor/errors.js';
import type { Clock } from '../../src/executor/types.js';

const fakeCtx = { taskId: 'task-1', runId: 'run-1', stepId: 'step-1' };

const fakeClock: Clock = {
  now: () => 0,
  setTimeout: (fn, ms) => {
    fn();
    return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
  },
  clearTimeout: () => {},
};

describe('@no-llm EthicsGateImpl', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeGate = async (robotsStatus = 200, robotsBody = 'User-agent: *\n') => {
    vi.mocked(fetch).mockResolvedValue({
      status: robotsStatus,
      text: () => Promise.resolve(robotsBody),
    } as unknown as Response);

    const blocklist = new BlocklistImpl();
    await blocklist.reload();

    const robots = new RobotsCacheImpl('YantraBot/0.1');
    const rateLimiter = new RateLimiterImpl(
      { tokensPerSecond: 100, burst: 100 },
      new Map(),
      fakeClock,
    );

    return new EthicsGateImpl(blocklist, robots, rateLimiter, 'YantraBot/0.1');
  };

  it('passes for a clean URL with no restrictions', async () => {
    const gate = await makeGate();
    await expect(gate.check('https://example.com/page', 'navigate', fakeCtx)).resolves.toBeUndefined();
  });

  it('throws EthicsRefusedError for a blocklisted host', async () => {
    const gate = await makeGate();
    await expect(
      gate.check('https://doubleclick.net/ad', 'navigate', fakeCtx),
    ).rejects.toThrow(EthicsRefusedError);
  });

  it('blocklist error has source=blocklist', async () => {
    const gate = await makeGate();
    try {
      await gate.check('https://google-analytics.com/collect', 'navigate', fakeCtx);
    } catch (err) {
      expect(err).toBeInstanceOf(EthicsRefusedError);
      expect((err as EthicsRefusedError).ethicsContext.source).toBe('blocklist');
    }
  });

  it('throws EthicsRefusedError for a robots-disallowed URL', async () => {
    const gate = await makeGate(200, 'User-agent: *\nDisallow: /private/');
    await expect(
      gate.check('https://example.com/private/secret', 'navigate', fakeCtx),
    ).rejects.toThrow(EthicsRefusedError);
  });

  it('robots error has source=robots', async () => {
    const gate = await makeGate(200, 'User-agent: *\nDisallow: /');
    try {
      await gate.check('https://example.com/any', 'navigate', fakeCtx);
    } catch (err) {
      expect(err).toBeInstanceOf(EthicsRefusedError);
      expect((err as EthicsRefusedError).ethicsContext.source).toBe('robots');
    }
  });

  it('blocklist check runs before robots (cheaper check first)', async () => {
    // If blocklist throws, fetch (robots) should never be called
    const gate = await makeGate();
    vi.mocked(fetch).mockClear();

    try {
      await gate.check('https://doubleclick.net/', 'navigate', fakeCtx);
    } catch {
      // expected
    }

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not throw for a 404 robots.txt (fail-open per RFC 9309)', async () => {
    const gate = await makeGate(404, '');
    await expect(gate.check('https://example.com/page', 'navigate', fakeCtx)).resolves.toBeUndefined();
  });

  it('throws for a 500 robots.txt (fail-closed)', async () => {
    const gate = await makeGate(500, '');
    await expect(
      gate.check('https://example.com/page', 'navigate', fakeCtx),
    ).rejects.toThrow(EthicsRefusedError);
  });
});
