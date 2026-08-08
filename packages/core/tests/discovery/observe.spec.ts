import { describe, expect, it, vi } from 'vitest';

import type { Page } from '../../src/browser/types.js';
import {
  scanInteractablesInPage,
  type RawInteractable,
} from '../../src/discovery/interactable-scan.js';
import {
  MAX_PAGE_DIGEST_LEN,
  buildObservation,
  mapRunOutcomeToStepOutcome,
  orderAgentInteractables,
} from '../../src/discovery/observe.js';
import type { Extractor } from '../../src/extraction/readability.js';
import type { ExtractedArticle, FetchedDoc } from '../../src/extraction/types.js';

interface FakePageOpts {
  readonly url?: string;
  readonly pageData?: { title: string; html: string } | 'throw';
  readonly rawInteractables?: readonly RawInteractable[] | 'throw';
  readonly locatorHost?: Page['locatorHost'];
}

class FakePage implements Pick<Page, 'evaluate' | 'url'> {
  public readonly locatorHost: Page['locatorHost'];

  public constructor(private readonly opts: FakePageOpts) {
    this.locatorHost = opts.locatorHost;
  }

  public url(): string {
    return this.opts.url ?? 'https://example.com/page';
  }

  public evaluate<T>(fn: () => T): Promise<T> {
    if (fn === scanInteractablesInPage) {
      if (this.opts.rawInteractables === 'throw') {
        return Promise.reject(new Error('scan failed'));
      }
      return Promise.resolve((this.opts.rawInteractables ?? []) as unknown as T);
    }
    if (this.opts.pageData === 'throw') {
      return Promise.reject(new Error('evaluate failed'));
    }
    return Promise.resolve(
      (this.opts.pageData ?? { title: 'Example', html: '<p>Hello world.</p>' }) as unknown as T,
    );
  }
}

function makePage(opts: FakePageOpts = {}): Page {
  return new FakePage(opts) as unknown as Page;
}

class FakeExtractor implements Extractor {
  public constructor(
    private readonly result: ExtractedArticle | null | 'throw' = {
      url: 'https://example.com/page',
      title: 'Example',
      byline: null,
      publishedAt: null,
      siteName: null,
      contentText: 'Hello world.',
      contentHtml: '<p>Hello world.</p>',
      excerpt: null,
      lengthChars: 12,
    },
  ) {}

  public extract(_doc: FetchedDoc): Promise<ExtractedArticle | null> {
    if (this.result === 'throw') {
      throw new Error('extract failed');
    }
    return Promise.resolve(this.result);
  }
}

function raw(overrides: Partial<RawInteractable> = {}): RawInteractable {
  return {
    role: 'button',
    name: 'Go',
    kind: 'button',
    disabled: false,
    top: 0,
    left: 0,
    group: null,
    scope: 'page',
    value: null,
    valuePresent: false,
    checked: null,
    expanded: null,
    selected: null,
    visible: true,
    ...overrides,
  };
}

describe('@no-llm panel-major agent interactable ordering', () => {
  it('keeps side-by-side calendar panels contiguous', () => {
    const ordered = orderAgentInteractables([
      raw({ name: 'Aug 1', group: 'August 2026', scope: 'dialog', top: 100, left: 100 }),
      raw({ name: 'Sep 1', group: 'September 2026', scope: 'dialog', top: 100, left: 400 }),
      raw({ name: 'Aug 2', group: 'August 2026', scope: 'dialog', top: 150, left: 100 }),
      raw({ name: 'Sep 2', group: 'September 2026', scope: 'dialog', top: 150, left: 400 }),
    ]);

    expect(ordered.map((entry) => entry.name)).toEqual(['Aug 1', 'Aug 2', 'Sep 1', 'Sep 2']);
  });

  it('retains ungrouped page chrome relative reading order', () => {
    const ordered = orderAgentInteractables([
      raw({ name: 'Footer', top: 300, left: 0 }),
      raw({ name: 'Header', top: 10, left: 0 }),
      raw({ name: 'Content', top: 100, left: 0 }),
    ]);

    expect(ordered.map((entry) => entry.name)).toEqual(['Header', 'Content', 'Footer']);
  });
});

describe('@no-llm buildObservation', () => {
  it('best-effort injects the locator runtime and degrades when injection rejects', async () => {
    const ensureInjected = vi.fn().mockRejectedValue(new Error('cross-origin'));
    const page = makePage({ locatorHost: { ensureInjected } as Page['locatorHost'] });

    await expect(
      buildObservation(
        page,
        { outcome: 'completed', reason: null },
        { extractor: new FakeExtractor() },
      ),
    ).resolves.toBeDefined();
    expect(ensureInjected).toHaveBeenCalledWith('main');
  });

  it('builds a full observation from a normal page', async () => {
    const page = makePage({
      url: 'https://example.com/results',
      pageData: { title: 'Results', html: '<p>Results found.</p>' },
      rawInteractables: [raw({ name: 'Buy now' })],
    });
    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor: new FakeExtractor() },
    );

    expect(observation.url).toBe('https://example.com/results');
    expect(observation.title).toBe('Results');
    expect(observation.page_digest).toContain('Hello world.');
    expect(observation.interactables).toEqual([
      { role: 'button', name: 'Buy now', kind: 'button', disabled: false },
    ]);
    expect(observation.step_outcome).toBe('completed');
    expect(observation.outcome_reason).toBeNull();
  });

  it('sanitizes credential-shaped content out of the digest', async () => {
    const page = makePage();
    const extractor = new FakeExtractor({
      url: 'https://example.com',
      title: null,
      byline: null,
      publishedAt: null,
      siteName: null,
      contentText: 'Contact us at admin@example.com or key sk-ABCDEF0123456789abcdef01',
      contentHtml: '',
      excerpt: null,
      lengthChars: 10,
    });

    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor },
    );

    expect(observation.page_digest).not.toContain('admin@example.com');
    expect(observation.page_digest).not.toContain('sk-ABCDEF0123456789abcdef01');
  });

  it('clamps an over-long digest to MAX_PAGE_DIGEST_LEN characters', async () => {
    const page = makePage();
    const longText = 'a'.repeat(MAX_PAGE_DIGEST_LEN + 5_000);
    const extractor = new FakeExtractor({
      url: 'https://example.com',
      title: null,
      byline: null,
      publishedAt: null,
      siteName: null,
      contentText: longText,
      contentHtml: '',
      excerpt: null,
      lengthChars: longText.length,
    });

    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor },
    );

    expect(observation.page_digest.length).toBeLessThanOrEqual(MAX_PAGE_DIGEST_LEN);
  });

  it('clamps an over-long title to 300 characters', async () => {
    const page = makePage({ pageData: { title: 'x'.repeat(400), html: '<p>hi</p>' } });
    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor: new FakeExtractor() },
    );
    expect(observation.title).toHaveLength(300);
  });

  it('returns a null title when the page has an empty title', async () => {
    const page = makePage({ pageData: { title: '', html: '<p>hi</p>' } });
    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor: new FakeExtractor() },
    );
    expect(observation.title).toBeNull();
  });

  it('degrades to an empty digest and null title when page.evaluate throws for title/html', async () => {
    const page = makePage({ pageData: 'throw' });
    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor: new FakeExtractor() },
    );
    expect(observation.title).toBeNull();
    expect(observation.page_digest).toBe('');
  });

  it('degrades to an empty interactables array when the scan throws', async () => {
    const page = makePage({ rawInteractables: 'throw' });
    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor: new FakeExtractor() },
    );
    expect(observation.interactables).toEqual([]);
  });

  it('degrades to an empty digest when the extractor throws', async () => {
    const page = makePage();
    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor: new FakeExtractor('throw') },
    );
    expect(observation.page_digest).toBe('');
  });

  it('degrades to an empty digest when the extractor returns null', async () => {
    const page = makePage();
    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor: new FakeExtractor(null) },
    );
    expect(observation.page_digest).toBe('');
  });

  it('caps interactables to 30 even when the raw scan returns more', async () => {
    const many = Array.from({ length: 50 }, (_, i) => raw({ top: i, name: `item-${i}` }));
    const page = makePage({ rawInteractables: many });
    const observation = await buildObservation(
      page,
      { outcome: 'completed', reason: null },
      { extractor: new FakeExtractor() },
    );
    expect(observation.interactables).toHaveLength(30);
  });

  it('threads a non-null outcome_reason through and clamps it to 500 chars', async () => {
    const page = makePage();
    const longReason = 'r'.repeat(600);
    const observation = await buildObservation(
      page,
      { outcome: 'failed', reason: longReason },
      { extractor: new FakeExtractor() },
    );
    expect(observation.step_outcome).toBe('failed');
    expect(observation.outcome_reason).toHaveLength(500);
  });

  it('produces a schema-valid observation for every step_outcome variant', async () => {
    const page = makePage();
    for (const outcome of [
      'completed',
      'failed',
      'ethics_refused',
      'confirmation_denied',
    ] as const) {
      await expect(
        buildObservation(
          page,
          { outcome, reason: outcome === 'completed' ? null : 'x' },
          { extractor: new FakeExtractor() },
        ),
      ).resolves.toBeDefined();
    }
  });
});

describe('@no-llm mapRunOutcomeToStepOutcome', () => {
  it('maps completed to completed with a null reason', () => {
    expect(mapRunOutcomeToStepOutcome({ status: 'completed' })).toEqual({
      outcome: 'completed',
      reason: null,
    });
  });

  it('maps a failed outcome with ethics_refused failureClass to ethics_refused', () => {
    const mapped = mapRunOutcomeToStepOutcome({ status: 'failed', failureClass: 'ethics_refused' });
    expect(mapped.outcome).toBe('ethics_refused');
    expect(mapped.reason).toContain('ethics gate');
  });

  it('maps any other failed failureClass to failed, naming the class in the reason', () => {
    const mapped = mapRunOutcomeToStepOutcome({ status: 'failed', failureClass: 'network_error' });
    expect(mapped.outcome).toBe('failed');
    expect(mapped.reason).toContain('network_error');
  });

  it('maps handoff to confirmation_denied (no generic handoff bucket in the schema)', () => {
    const mapped = mapRunOutcomeToStepOutcome({ status: 'handoff' });
    expect(mapped.outcome).toBe('confirmation_denied');
    expect(mapped.reason).not.toBeNull();
  });
});
