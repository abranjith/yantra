import { describe, expect, it } from 'vitest';

import { EthicsRefusedError } from '../../src/executor/errors.js';
import {
  DocumentStore,
  UnreadableContentError,
  isTerminalFetchFailure,
  type LoadOutcome,
} from '../../src/extraction/document-store.js';
import { FetchError } from '../../src/extraction/fetcher.js';

const BASE = { taskId: 't', runId: 'r', stepId: 's' };

/** A counting loader that succeeds with the given final URL (or none). */
function okLoader(
  url: string,
  finalUrl: string | null = null,
): { readonly calls: () => number; readonly load: () => Promise<LoadOutcome<string>> } {
  let calls = 0;
  return {
    calls: () => calls,
    load: () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        value: `body of ${url}`,
        meta: { url, finalUrl, title: `Title ${url}`, fetchMode: 'http', tool: 'web_fetch' },
      });
    },
  };
}

function failLoader(terminal: boolean, code = 'FETCH_HTTP_ERROR') {
  let calls = 0;
  return {
    calls: () => calls,
    load: (): Promise<LoadOutcome<string>> => {
      calls += 1;
      return Promise.resolve({
        ok: false,
        terminal,
        code,
        reason: 'reason',
        failure: { code, n: calls },
      });
    },
  };
}

describe('@no-llm extraction/document-store read', () => {
  it('three sequential reads load once: fetched, then two hits with the same S1', async () => {
    const store = new DocumentStore();
    const loader = okLoader('https://a.com/x');

    const first = await store.read('https://a.com/x', loader.load);
    const second = await store.read('https://a.com/x', loader.load);
    const third = await store.read('https://a.com/x', loader.load);

    expect(loader.calls()).toBe(1);
    expect(first.kind).toBe('fetched');
    expect(second.kind).toBe('hit');
    expect(third.kind).toBe('hit');
    if (first.kind !== 'fetched' || third.kind !== 'hit') throw new Error('unreachable');
    expect(first.value).toBe('body of https://a.com/x');
    expect(first.record.sourceId).toBe('S1');
    expect(third.record.sourceId).toBe('S1');
    expect(third.record.reads).toBe(3);
    expect(store.stats()).toEqual({ networkLoads: 1, hits: 2, memoHits: 0, observed: 0 });
  });

  it('two concurrent reads share one load and both resolve to S1', async () => {
    const store = new DocumentStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const load = async (): Promise<LoadOutcome<string>> => {
      calls += 1;
      await gate;
      return {
        ok: true,
        value: 'v',
        meta: {
          url: 'https://a.com/x',
          finalUrl: null,
          title: null,
          fetchMode: 'http',
          tool: 'web_search',
        },
      };
    };

    const pending = [store.read('https://a.com/x', load), store.read('https://a.com/x#frag', load)];
    release();
    const [left, right] = await Promise.all(pending);

    expect(calls).toBe(1);
    expect([left?.kind, right?.kind].sort()).toEqual(['fetched', 'hit']);
    expect(left?.kind === 'failed' ? null : left?.record.sourceId).toBe('S1');
    expect(right?.kind === 'failed' ? null : right?.record.sourceId).toBe('S1');
  });

  it('a redirect target counts as already read', async () => {
    const store = new DocumentStore();
    const a = okLoader('https://a.com/old', 'https://a.com/new');
    const b = okLoader('https://a.com/new');

    const first = await store.read('https://a.com/old', a.load);
    const second = await store.read('https://a.com/new', b.load);

    expect(first.kind).toBe('fetched');
    expect(second.kind).toBe('hit');
    expect(b.calls()).toBe(0);
    if (first.kind !== 'fetched') throw new Error('unreachable');
    expect(first.record.finalUrl).toBe('https://a.com/new');
  });

  it('a redirect INTO a page already read answers with the existing record, minting nothing', async () => {
    const store = new DocumentStore();
    await store.read('https://a.com/new', okLoader('https://a.com/new').load);

    const redirected = await store.read(
      'https://a.com/old',
      okLoader('https://a.com/old', 'https://a.com/new').load,
    );

    expect(redirected.kind).toBe('hit');
    if (redirected.kind !== 'hit') throw new Error('unreachable');
    expect(redirected.record.sourceId).toBe('S1');
    expect(store.entries()).toHaveLength(1);
    // The old URL now resolves without another load.
    expect(store.lookup('https://a.com/old')?.sourceId).toBe('S1');
  });

  it('collapses URL variants to one record', async () => {
    const store = new DocumentStore();
    const loader = okLoader('https://A.com/x/?utm_source=n#f');

    await store.read('https://A.com/x/?utm_source=n#f', loader.load);
    const again = await store.read('https://a.com:443/x', loader.load);

    expect(loader.calls()).toBe(1);
    expect(again.kind).toBe('hit');
    expect(store.entries()).toHaveLength(1);
  });

  it('memoizes a terminal failure: a re-read makes zero loads and reports memoized', async () => {
    const store = new DocumentStore();
    const loader = failLoader(true);

    const first = await store.read('https://a.com/404', loader.load);
    const second = await store.read('https://a.com/404', loader.load);

    expect(loader.calls()).toBe(1);
    expect(first).toMatchObject({ kind: 'failed', memoized: false, code: 'FETCH_HTTP_ERROR' });
    // The memo replays the ORIGINAL failure payload, not a new one.
    expect(second).toMatchObject({
      kind: 'failed',
      memoized: true,
      code: 'FETCH_HTTP_ERROR',
      failure: { code: 'FETCH_HTTP_ERROR', n: 1 },
    });
    expect(store.stats().memoHits).toBe(1);
  });

  it('never memoizes a non-terminal failure: a re-read loads again', async () => {
    const store = new DocumentStore();
    const loader = failLoader(false, 'FETCH_TIMEOUT');

    await store.read('https://a.com/slow', loader.load);
    const second = await store.read('https://a.com/slow', loader.load);

    expect(loader.calls()).toBe(2);
    expect(second).toMatchObject({ kind: 'failed', memoized: false });
  });

  it('a non-terminal failure followed by a success mints normally', async () => {
    const store = new DocumentStore();
    await store.read('https://a.com/x', failLoader(false).load);

    const ok = await store.read('https://a.com/x', okLoader('https://a.com/x').load);

    expect(ok.kind).toBe('fetched');
    if (ok.kind !== 'fetched') throw new Error('unreachable');
    expect(ok.record.sourceId).toBe('S1');
  });

  it('mints dense IDs across interleaved failures', async () => {
    const store = new DocumentStore();

    const one = await store.read('https://a.com/1', okLoader('https://a.com/1').load);
    await store.read('https://a.com/bad', failLoader(true).load);
    const two = await store.read('https://a.com/2', okLoader('https://a.com/2').load);

    expect(one.kind === 'fetched' && one.record.sourceId).toBe('S1');
    expect(two.kind === 'fetched' && two.record.sourceId).toBe('S2');
    expect(store.entries().map((entry) => entry.sourceId)).toEqual(['S1', 'S2']);
  });

  it('propagates an unexpected throw without memoizing it', async () => {
    const store = new DocumentStore();
    let calls = 0;
    const boom = (): Promise<LoadOutcome<string>> => {
      calls += 1;
      return Promise.reject(new TypeError('boom'));
    };

    await expect(store.read('https://a.com/x', boom)).rejects.toThrow('boom');
    await expect(store.read('https://a.com/x', boom)).rejects.toThrow('boom');
    expect(calls).toBe(2);
    expect(store.entries()).toHaveLength(0);
  });

  it('a concurrent joiner of a throwing load receives the throw too', async () => {
    const store = new DocumentStore();
    let reject: (error: Error) => void = () => undefined;
    const load = (): Promise<LoadOutcome<string>> =>
      new Promise((_resolve, rejectLoad) => {
        reject = rejectLoad;
      });

    const first = store.read('https://a.com/x', load);
    const second = store.read('https://a.com/x', load);
    reject(new Error('down'));

    await expect(first).rejects.toThrow('down');
    await expect(second).rejects.toThrow('down');
  });

  it('a concurrent joiner of a terminal failure is told it was already attempted', async () => {
    const store = new DocumentStore();
    let finish: (outcome: LoadOutcome<string>) => void = () => undefined;
    const load = (): Promise<LoadOutcome<string>> =>
      new Promise((resolve) => {
        finish = resolve;
      });

    const first = store.read('https://a.com/x', load);
    const second = store.read('https://a.com/x', load);
    finish({ ok: false, terminal: true, code: 'C', reason: 'r', failure: null });

    expect(await first).toMatchObject({ kind: 'failed', memoized: false });
    expect(await second).toMatchObject({ kind: 'failed', memoized: true });
  });

  it('a throwing load with no joiner raises no unhandled rejection', async () => {
    const store = new DocumentStore();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        store.read('https://a.com/x', () => Promise.reject(new Error('x'))),
      ).rejects.toThrow('x');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('@no-llm extraction/document-store observe and lookups', () => {
  it('observe mints without any load, and a later read of the same URL is a hit', async () => {
    const store = new DocumentStore(() => '2026-10-11T00:00:00.000Z');

    const observed = store.observe('https://a.com/live', {
      title: 'Live',
      tool: 'browser_extract',
    });
    const loader = okLoader('https://a.com/live');
    const read = await store.read('https://a.com/live', loader.load);

    expect(observed).toMatchObject({
      sourceId: 'S1',
      fetchMode: 'observed',
      firstTool: 'browser_extract',
      firstReadAt: '2026-10-11T00:00:00.000Z',
    });
    expect(read.kind).toBe('hit');
    expect(loader.calls()).toBe(0);
    expect(store.stats()).toMatchObject({ networkLoads: 0, observed: 1 });
  });

  it('observing a page already read returns its existing ID', async () => {
    const store = new DocumentStore();
    await store.read('https://a.com/x', okLoader('https://a.com/x').load);

    expect(
      store.observe('https://a.com/x/', { title: null, tool: 'browser_extract' }).sourceId,
    ).toBe('S1');
    expect(store.stats().observed).toBe(0);
  });

  it('attachCapture sets the first capture reference only', async () => {
    const store = new DocumentStore();
    await store.read('https://a.com/x', okLoader('https://a.com/x').load);

    store.attachCapture('S1', 'captures/one.txt');
    store.attachCapture('S1', 'captures/two.txt');
    store.attachCapture('S9', 'captures/ghost.txt');

    expect(store.get('S1')?.captureRef).toBe('captures/one.txt');
    expect(store.get('S9')).toBeNull();
  });

  it('returns frozen snapshots that cannot mutate the store', async () => {
    const store = new DocumentStore();
    const read = await store.read('https://a.com/x', okLoader('https://a.com/x').load);
    if (read.kind !== 'fetched') throw new Error('unreachable');

    expect(Object.isFrozen(read.record)).toBe(true);
    expect(store.lookup('https://a.com/nope')).toBeNull();
  });
});

describe('@no-llm extraction/document-store isTerminalFetchFailure', () => {
  const fetchError = (kind: FetchError['context']['kind'], statusCode?: number): FetchError =>
    new FetchError('x', {
      url: 'https://a.com',
      kind,
      ...(statusCode === undefined ? {} : { statusCode }),
    });

  it.each([
    [404, true],
    [400, true],
    [403, true],
    [410, true],
    [408, false],
    [429, false],
    [500, false],
    [503, false],
  ])('HTTP %s is terminal: %s', (status, terminal) => {
    expect(isTerminalFetchFailure(fetchError('http-status', status))).toBe(terminal);
  });

  it('an HTTP failure with no status is not terminal', () => {
    expect(isTerminalFetchFailure(fetchError('http-status'))).toBe(false);
  });

  it.each([
    ['too-large', true],
    ['challenge', true],
    ['timeout', false],
    ['network', false],
  ] as const)('fetch kind %s is terminal: %s', (kind, terminal) => {
    expect(isTerminalFetchFailure(fetchError(kind))).toBe(terminal);
  });

  it('refused content types and empty extraction are terminal', () => {
    expect(isTerminalFetchFailure(new UnreadableContentError('content-type-refused'))).toBe(true);
    expect(isTerminalFetchFailure(new UnreadableContentError('extraction-empty'))).toBe(true);
  });

  it.each([
    ['robots', true],
    ['blocklist', true],
    ['rate_limit', false],
  ] as const)('an ethics %s refusal is terminal: %s', (source, terminal) => {
    const error = new EthicsRefusedError({ host: 'a.com', rule: 'r', reason: 'x', source }, BASE);
    expect(isTerminalFetchFailure(error)).toBe(terminal);
  });

  it('unknown values are not terminal', () => {
    expect(isTerminalFetchFailure(new Error('x'))).toBe(false);
    expect(isTerminalFetchFailure(null)).toBe(false);
    expect(isTerminalFetchFailure('BUDGET_EXHAUSTED')).toBe(false);
  });
});
