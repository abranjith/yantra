/**
 * The shared live-page read used by both the agent's observation digest and
 * the replayed `extract` step's `readable` schema. The two used to hand-roll
 * this stage separately and disagreed about the same page; these pin the
 * contract they now share.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  analyzeLivePage,
  extractLivePageArticle,
  extractLivePageText,
} from '../../src/extraction/live-page.js';
import { ReadabilityExtractor, type Extractor } from '../../src/extraction/readability.js';
import type { ExtractedArticle, FetchedDoc } from '../../src/extraction/types.js';

/** A page with prose, wrapped in the chrome Readability is there to remove. */
const ARTICLE_PAGE = `<!doctype html><html><head><title>Tracking</title></head><body>
  <nav>Skip to Main Content Login Shipping Support</nav>
  <script>window.dataLayer = []; function noise() { return 'INLINE_SCRIPT_NOISE'; }</script>
  <main><article>
    <h1>Shipment status</h1>
    <p>Your package left the origin facility on Monday morning and is currently
    in transit to the destination sorting centre, where it is expected to arrive
    within the next two business days.</p>
    <p>No signature will be required on delivery. The courier will leave the
    parcel in the safe place recorded against this address if nobody answers
    the door when they call.</p>
  </article></main>
  <footer>Cookie preferences Terms of Use Privacy Notice</footer>
</body></html>`;

function extractorReturning(article: ExtractedArticle | null): Extractor {
  return { extract: () => Promise.resolve(article) };
}

function article(contentText: string): ExtractedArticle {
  return {
    url: 'https://example.test/',
    title: null,
    byline: null,
    publishedAt: null,
    siteName: null,
    contentText,
    contentHtml: '',
    excerpt: null,
    lengthChars: contentText.length,
  };
}

describe('@no-llm extraction/live-page', () => {
  it('prefers the readable article over the page chrome around it', async () => {
    const text = await extractLivePageText(
      { extractor: new ReadabilityExtractor() },
      { url: 'https://carrier.test/track', html: ARTICLE_PAGE, visibleText: 'unused fallback' },
    );

    expect(text).toContain('left the origin facility');
    // The three things a raw `textContent` read drags in.
    expect(text).not.toContain('INLINE_SCRIPT_NOISE');
    expect(text).not.toContain('Skip to Main Content');
    expect(text).not.toContain('Privacy Notice');
  });

  it('falls back to the rendered text when there is no article', async () => {
    const text = await extractLivePageText(extractorless(), {
      url: 'https://app.test/orders',
      html: '<div><span>Status</span><span>Delivered</span></div>',
      visibleText: 'Status\nDelivered',
    });

    expect(text).toBe('Status\nDelivered');
  });

  it('normalizes the fallback text the same way the article path is normalized', async () => {
    // NBSP, a footnote marker, a doubled card title, and ragged blank lines —
    // all things `innerText` hands over verbatim and the HTML path already
    // cleans. The fallback must not be the dirty one of the two.
    const text = await extractLivePageText(extractorless(), {
      url: 'https://app.test/orders',
      html: '<div>x</div>',
      visibleText: '  Order status[3]  \n\n\n\nDelivered Monday\n\nDelivered Monday\n',
    });

    // The NBSP became a space, the marker is gone, the blank-line run
    // collapsed, and the block the page rendered twice appears once.
    expect(text).toBe('Order status\n\nDelivered Monday');
  });

  it('returns empty when there is no article and no rendered text', async () => {
    // The observation-digest contract: that caller passes no `visibleText`, so
    // an article-less page still digests to '' exactly as it did before the
    // two paths were merged.
    const text = await extractLivePageText(extractorless(), {
      url: 'https://app.test/orders',
      html: '<div>Delivered</div>',
    });

    expect(text).toBe('');
  });

  it('degrades to the fallback instead of throwing when extraction blows up', async () => {
    // A page read must never be able to fail a run or an agent turn.
    const extractor: Extractor = {
      extract: () => {
        throw new Error('jsdom exploded');
      },
    };

    await expect(
      extractLivePageText(
        { extractor },
        { url: 'https://app.test/', html: '<div>x</div>', visibleText: 'Delivered' },
      ),
    ).resolves.toBe('Delivered');
    await expect(
      extractLivePageArticle({ extractor }, { url: 'https://app.test/', html: '<div>x</div>' }),
    ).resolves.toBeNull();
  });

  it('skips extraction entirely for empty markup', async () => {
    const extract = vi.fn(() => Promise.resolve(article('never reached')));

    const text = await extractLivePageText(
      { extractor: { extract } },
      { url: 'about:blank', html: '' },
    );

    expect(text).toBe('');
    expect(extract).not.toHaveBeenCalled();
  });

  it('passes the caller-supplied read timestamp through to the extractor', async () => {
    // Replay derives it from the run clock so a re-run's artifacts match.
    const seen: FetchedDoc[] = [];
    const extractor: Extractor = {
      extract: (doc) => {
        seen.push(doc);
        return Promise.resolve(article('body'));
      },
    };

    await extractLivePageText(
      { extractor },
      { url: 'https://app.test/', html: '<p>body</p>', fetchedAt: '2026-05-11T10:14:00.000Z' },
    );

    expect(seen[0]?.fetchedAt).toBe('2026-05-11T10:14:00.000Z');
    expect(seen[0]?.finalUrl).toBe('https://app.test/');
    expect(seen[0]?.fetchMode).toBe('browser');
  });

  it('treats a whitespace-only article as no article at all', async () => {
    const text = await extractLivePageText(
      { extractor: extractorReturning(article('   \n  ')) },
      { url: 'https://app.test/', html: '<p> </p>', visibleText: 'Delivered' },
    );

    expect(text).toBe('Delivered');
  });
});

/** Deps whose extractor finds no article — the app-shell case. */
function extractorless(): { readonly extractor: Extractor } {
  return { extractor: extractorReturning(null) };
}

describe('@no-llm extraction/live-page analyzeLivePage (FEAT-051)', () => {
  const extractor = new ReadabilityExtractor();
  const TWO_TABLES =
    '<html><head><title>Specs</title></head><body><main><h1>Specs</h1>' +
    '<table><tr><th>Day</th><th>Opens</th></tr><tr><td>Mon</td><td>9:00</td></tr><tr><td>Tue</td><td>9:00</td></tr><tr><td>Wed</td><td>9:00</td></tr></table>' +
    '<table><tr><th>Trim</th><th>Towing</th></tr><tr><td>Base</td><td>1,500 lb</td></tr><tr><td>Ridge</td><td>3,500 lb</td></tr><tr><td>Summit</td><td>4,500 lb</td></tr></table>' +
    '</main></body></html>';

  it('reads a snapshot through the same analyzer as a fetch, in browser mode', async () => {
    const snapshot = {
      url: 'https://specs.test/page',
      title: 'Specs',
      html: TWO_TABLES,
      visibleText: '',
      truncated: false,
    };
    const live = await analyzeLivePage({ extractor }, snapshot);
    const fetched = await extractor.extractPage({
      url: snapshot.url,
      finalUrl: snapshot.url,
      fetchedAt: 'x',
      contentType: 'text/html',
      html: TWO_TABLES,
      statusCode: 200,
      fetchMode: 'browser',
      elapsedMs: 0,
    });

    expect(live.page.tables).toHaveLength(2);
    expect(live.page.tables[1]?.rows).toContainEqual(['Summit', '4,500 lb']);
    expect(live.page.coverage.fetch_mode).toBe('browser');
    expect(live.page).toEqual(fetched.page);
  });

  it('reports a snapshot cut at the byte cap in coverage', async () => {
    const live = await analyzeLivePage(
      { extractor },
      {
        url: 'https://specs.test/page',
        title: 'Specs',
        html: TWO_TABLES,
        visibleText: '',
        truncated: true,
      },
    );
    expect(live.page.coverage.omitted).toContainEqual({ id: 'snapshot-truncated', count: 1 });
  });
});
