import type { ElementHandle } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';

import { LocatorResolverImpl } from '../../src/locator/resolver.js';
import type {
  EngineLocatorCandidate,
  EngineLocatorChain,
  InjectedScriptHost,
  LocatorEventSink,
  LocatorResolutionEvent,
} from '../../src/locator/types.js';

function makeFakeHandle(): ElementHandle {
  return { _fake: true } as unknown as ElementHandle;
}

function makeChain(
  candidates: EngineLocatorCandidate[],
  opts: { name?: string; strict?: boolean } = {},
): EngineLocatorChain {
  return {
    name: opts.name ?? 'Test chain',
    candidates,
    strict: opts.strict ?? true,
  };
}

function makeCssCandidate(selector = 'button'): EngineLocatorCandidate {
  return { intent: { kind: 'css', selector }, source: 'authored' };
}

function makeHost(overrides: Partial<InjectedScriptHost> = {}): InjectedScriptHost {
  return {
    ensureInjected: vi.fn().mockResolvedValue(undefined),
    call: vi.fn().mockResolvedValue({ count: 0 }),
    callHandle: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('@no-llm LocatorResolverImpl.resolve', () => {
  it('returns success when candidate 0 matches (count=1)', async () => {
    const handle = makeFakeHandle();
    const host = makeHost({
      call: vi.fn().mockResolvedValue({ count: 1, slotKey: 'default' }),
      callHandle: vi.fn().mockResolvedValue(handle),
    });

    const resolver = new LocatorResolverImpl(host);
    const chain = makeChain([makeCssCandidate('button')]);

    const result = await resolver.resolve(chain);

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.usedCandidateIndex).toBe(0);
      expect(result.elementHandle).toBe(handle);
      expect(result.candidatesTried).toHaveLength(1);
      expect(result.candidatesTried[0]?.outcome).toBe('matched');
    }
  });

  it('falls through to candidate 1 when candidate 0 has no match', async () => {
    const handle = makeFakeHandle();
    const callMock = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 }) // candidate 0 misses
      .mockResolvedValueOnce({ count: 1, slotKey: 'default' }) // candidate 1 wins
      .mockResolvedValue(undefined); // clearSlot

    const host = makeHost({
      call: callMock,
      callHandle: vi.fn().mockResolvedValue(handle),
    });

    const resolver = new LocatorResolverImpl(host);
    const chain = makeChain([makeCssCandidate('.nonexistent'), makeCssCandidate('button')]);

    const result = await resolver.resolve(chain);

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.usedCandidateIndex).toBe(1);
      expect(result.candidatesTried).toHaveLength(2);
      expect(result.candidatesTried[0]?.outcome).toBe('no_match');
      expect(result.candidatesTried[1]?.outcome).toBe('matched');
    }
  });

  it('returns not_found when all candidates miss', async () => {
    const host = makeHost({
      call: vi.fn().mockResolvedValue({ count: 0 }),
    });

    const resolver = new LocatorResolverImpl(host);
    const chain = makeChain([makeCssCandidate('.miss1'), makeCssCandidate('.miss2')]);

    const result = await resolver.resolve(chain);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('not_found');
      expect(result.candidatesTried).toHaveLength(2);
    }
  });

  it('reports ambiguous when strict mode exhausts the chain and a candidate matched >1', async () => {
    const callMock = vi
      .fn()
      .mockResolvedValueOnce({ count: 3 }) // candidate 0: ambiguous
      .mockResolvedValueOnce({ count: 0 }); // candidate 1: no match

    const host = makeHost({ call: callMock });
    const resolver = new LocatorResolverImpl(host);
    const chain = makeChain([makeCssCandidate('.ambiguous'), makeCssCandidate('.also-misses')], {
      strict: true,
    });

    const result = await resolver.resolve(chain);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      // Ambiguity outranks not_found in the report: "matches 3 elements" tells
      // the author what to fix, "nothing matched" sends them hunting a page change.
      expect(result.reason).toBe('ambiguous');
      expect(result.candidatesTried).toHaveLength(2);
      expect(result.candidatesTried[0]?.outcome).toBe('ambiguous');
      expect(result.candidatesTried[0]?.matchCount).toBe(3);
      expect(result.candidatesTried[1]?.outcome).toBe('no_match');
    }
    expect(callMock).toHaveBeenCalledTimes(2);
  });

  it('falls through an ambiguous strict candidate to a narrower one that resolves', async () => {
    const handle = makeFakeHandle();
    const callMock = vi
      .fn()
      .mockResolvedValueOnce({ count: 4 }) // role+name also matches hidden duplicates
      .mockResolvedValueOnce({ count: 1, slotKey: 'default' }); // unique CSS pins it

    const host = makeHost({
      call: callMock,
      callHandle: vi.fn().mockResolvedValue(handle),
    });
    const resolver = new LocatorResolverImpl(host);
    const chain = makeChain([makeCssCandidate('.broad'), makeCssCandidate('#unique')], {
      strict: true,
    });

    const result = await resolver.resolve(chain);

    // The whole point of a ranked chain: a broad candidate that cannot pick a
    // single element hands off to a narrower one instead of failing the run.
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.usedCandidateIndex).toBe(1);
      expect(result.elementHandle).toBe(handle);
      expect(result.candidatesTried[0]?.outcome).toBe('ambiguous');
      expect(result.candidatesTried[1]?.outcome).toBe('matched');
    }
  });

  it('accepts the first match for a non-strict chain that matches several elements', async () => {
    const handle = makeFakeHandle();
    const host = makeHost({
      call: vi.fn().mockResolvedValue({ count: 3, slotKey: 'default' }),
      callHandle: vi.fn().mockResolvedValue(handle),
    });

    const resolver = new LocatorResolverImpl(host);
    const chain = makeChain([makeCssCandidate('.many')], { strict: false });

    const result = await resolver.resolve(chain);

    // Non-strict means "several matches are acceptable, take the first" — it
    // previously meant "several matches count as no match", which walked past
    // a candidate that had in fact found the element.
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.usedCandidateIndex).toBe(0);
      expect(result.elementHandle).toBe(handle);
      expect(result.candidatesTried[0]?.matchCount).toBe(3);
      expect(result.candidatesTried[0]?.outcome).toBe('matched');
    }
  });

  it('returns frame_detached when host throws frame-detached error', async () => {
    const frameError = new Error('frame was detached');
    frameError.name = 'FrameDetachedError';

    const host = makeHost({
      call: vi.fn().mockRejectedValue(frameError),
    });

    const resolver = new LocatorResolverImpl(host);
    const chain = makeChain([makeCssCandidate('button')]);

    const result = await resolver.resolve(chain);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('frame_detached');
    }
  });

  it('records attempt as error and continues when candidate call times out', async () => {
    const handle = makeFakeHandle();
    // First candidate takes longer than timeout (we'll not actually wait — mock rejection)
    const timeoutError = new Error('candidate [0] timed out after 5000ms');
    const callMock = vi
      .fn()
      .mockRejectedValueOnce(timeoutError) // candidate 0 times out
      .mockResolvedValueOnce({ count: 1, slotKey: 'default' }) // candidate 1 succeeds
      .mockResolvedValue(undefined);

    const host = makeHost({
      call: callMock,
      callHandle: vi.fn().mockResolvedValue(handle),
    });

    const resolver = new LocatorResolverImpl(host);
    const chain = makeChain([makeCssCandidate('.slow'), makeCssCandidate('button')]);

    const result = await resolver.resolve(chain);

    // Should fall through to candidate 1 and succeed
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.usedCandidateIndex).toBe(1);
      expect(result.candidatesTried[0]?.outcome).toBe('error');
    }
  });

  it('emits locator_resolution event on success', async () => {
    const events: LocatorResolutionEvent[] = [];
    const sink: LocatorEventSink = { emit: (e) => events.push(e) };
    const handle = makeFakeHandle();

    const host = makeHost({
      call: vi.fn().mockResolvedValue({ count: 1, slotKey: 'default' }),
      callHandle: vi.fn().mockResolvedValue(handle),
    });

    const resolver = new LocatorResolverImpl(host, sink);
    const chain = makeChain([makeCssCandidate('button')], { name: 'Sign in button' });

    await resolver.resolve(chain);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('locator_resolution');
    expect(events[0]?.chain_name).toBe('Sign in button');
    expect(events[0]?.winning_index).toBe(0);
    expect(events[0]?.outcome).toBe('success');
  });

  it('emits locator_resolution event on failure with null winning_index', async () => {
    const events: LocatorResolutionEvent[] = [];
    const sink: LocatorEventSink = { emit: (e) => events.push(e) };

    const host = makeHost({
      call: vi.fn().mockResolvedValue({ count: 0 }),
    });

    const resolver = new LocatorResolverImpl(host, sink);
    const chain = makeChain([makeCssCandidate('.miss')], { name: 'Missing element' });

    await resolver.resolve(chain);

    expect(events).toHaveLength(1);
    expect(events[0]?.winning_index).toBeNull();
    expect(events[0]?.outcome).toBe('not_found');
  });

  it('event payload contains no DOM data or raw values (security invariant)', async () => {
    const events: LocatorResolutionEvent[] = [];
    const sink: LocatorEventSink = { emit: (e) => events.push(e) };

    const host = makeHost({
      call: vi.fn().mockResolvedValue({ count: 1, slotKey: 'default' }),
      callHandle: vi.fn().mockResolvedValue(makeFakeHandle()),
    });

    const resolver = new LocatorResolverImpl(host, sink);
    const chain = makeChain([makeCssCandidate('button')], { name: 'Submit' });

    await resolver.resolve(chain);

    const payload = JSON.stringify(events[0]);
    // Should not contain anything that looks like a DOM node or raw page content
    expect(payload).not.toContain('innerHTML');
    expect(payload).not.toContain('textContent');
    expect(payload).not.toContain('objectId');
    expect(payload.length).toBeGreaterThan(0);
  });

  it('duration_ms in event is non-negative', async () => {
    const events: LocatorResolutionEvent[] = [];
    const sink: LocatorEventSink = { emit: (e) => events.push(e) };

    const host = makeHost({
      call: vi.fn().mockResolvedValue({ count: 1 }),
      callHandle: vi.fn().mockResolvedValue(makeFakeHandle()),
    });

    const resolver = new LocatorResolverImpl(host, sink);
    await resolver.resolve(makeChain([makeCssCandidate()]), { candidateTimeoutMs: 1000 });

    expect(events[0]?.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
