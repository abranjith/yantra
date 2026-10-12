import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultSanitizer,
  ReadabilityExtractor,
  type PageAnalysis,
  type PageShape,
  type StoredPage,
} from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXCERPT_CHARS,
  fullViewBudget,
  offerableUrl,
  projectPage,
  recordDiscovered,
  summaryBudget,
} from '../../../../src/adapters/pi/tools/page-payload.js';
import { webFetchSpec } from '../../../../src/adapters/pi/tools/web-fetch.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import { UrlProvenance } from '../../../../src/runtime/url-provenance.js';

import {
  articleHtml,
  detailHtml,
  emptyHtml,
  hubHtml,
  listingHtml,
  multiTableHtml,
} from './page-fixtures.js';
import { attestedHosts, buildServices, fetchedDoc } from './test-support.js';

/** An analysis holding every part, so view order is observable for any shape. */
function everyPart(shape: PageShape, overrides: Partial<PageAnalysis> = {}): PageAnalysis {
  return {
    shape,
    records: [
      {
        key: 'https://shop.test/r/1',
        title: 'Record one',
        url: 'https://shop.test/r/1',
        segments: ['first segment'],
        fields: [],
        numbers: [{ kind: 'currency', text: '$5', value: 5 }],
        links: [],
      },
    ],
    structured: [{ type: 'Product', from: 'json-ld', props: { name: 'P' } }],
    tables: [{ index: 0, kind: 'data', caption: null, headers: ['a', 'b'], rows: [['1', '2']] }],
    fields: [{ label: 'Color', value: 'Red' }],
    links: [
      { text: 'Next', url: 'https://shop.test/list?page=2', kind: 'pagination', sameSite: true },
    ],
    recordLinkCount: 1,
    readableText: 'Readable text.',
    coverage: { shape_basis: `${shape}: test`, fetch_mode: 'http', not_found: [], omitted: [] },
    ...overrides,
  };
}

function stored(analysis: PageAnalysis, delivered: 'full' | 'summary' = 'full'): StoredPage {
  const anchors = new Map(analysis.records.map((record, index) => [record.key, index + 1]));
  return { analysis, anchors, article: { byline: 'By A', publishedAt: null }, delivered };
}

describe('@no-llm page payload projection (FEAT-051)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-page-payload-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const services = (): ReturnType<typeof buildServices> => buildServices({ runDir });

  async function project(
    analysis: PageAnalysis,
    view: 'full' | 'summary' = 'full',
    budget = 100_000,
  ): Promise<Awaited<ReturnType<typeof projectPage>>> {
    return projectPage(
      { sourceId: 'S1', url: 'https://shop.test/list', title: 'List', page: stored(analysis) },
      view,
      budget,
      services(),
    );
  }

  describe('full view order', () => {
    it.each([
      ['collection', ['records', 'fields', 'tables', 'structured', 'links', 'text']],
      ['table', ['tables', 'fields', 'structured', 'records', 'links', 'text']],
      ['detail', ['fields', 'tables', 'structured', 'records', 'links', 'text']],
      ['index', ['links', 'fields', 'tables', 'structured', 'records', 'text']],
    ] as const)('%s leads with its primary part', async (shape, parts) => {
      const { model } = await project(everyPart(shape));
      expect(Object.keys(model)).toEqual([
        'source_id',
        'url',
        'title',
        'shape',
        ...parts,
        'coverage',
      ]);
    });

    it('article leads with byline, date, and text', async () => {
      const { model } = await project(everyPart('article'));
      expect(Object.keys(model)).toEqual([
        'source_id',
        'url',
        'title',
        'shape',
        'byline',
        'published_at',
        'text',
        'fields',
        'tables',
        'structured',
        'records',
        'links',
        'coverage',
      ]);
    });

    it('omits empty parts', async () => {
      const { model } = await project(
        everyPart('article', { records: [], structured: [], tables: [], fields: [], links: [] }),
      );
      expect(Object.keys(model)).toEqual([
        'source_id',
        'url',
        'title',
        'shape',
        'byline',
        'published_at',
        'text',
        'coverage',
      ]);
    });
  });

  describe('wire forms', () => {
    it('gives records anchored IDs and omits their empty members', async () => {
      const { model } = await project(everyPart('collection'));
      expect(model.records).toEqual([
        {
          id: 'S1#r1',
          title: 'Record one',
          url: 'https://shop.test/r/1',
          text: ['first segment'],
          numbers: [{ kind: 'currency', text: '$5' }],
        },
      ]);
      expect(model.links).toEqual([
        { text: 'Next', url: 'https://shop.test/list?page=2', kind: 'pagination' },
      ]);
    });

    it('suffixes a repeated field label with (2)', async () => {
      const { model } = await project(
        everyPart('detail', {
          fields: [
            { label: 'Color', value: 'Red' },
            { label: 'Color', value: 'Blue' },
            { label: 'Color', value: 'Green' },
          ],
        }),
      );
      expect(model.fields).toEqual({ Color: 'Red', 'Color (2)': 'Blue', 'Color (3)': 'Green' });
    });

    it('renders core omissions through the registered templates', async () => {
      const { model } = await project(
        everyPart('collection', {
          coverage: {
            shape_basis: 'collection: test',
            fetch_mode: 'http',
            not_found: [],
            omitted: [
              { id: 'records-beyond-limit', count: 35, paginationOffered: true },
              { id: 'table-rows-beyond-limit', count: 10, table: 2 },
            ],
          },
        }),
      );
      expect((model.coverage as { omitted: string[] }).omitted).toEqual([
        '35 records beyond the first 25 were not shown; pagination links are in links[], and web_fetch of one reads the next page.',
        'Table 2: 10 rows beyond the first 50 were not shown; no tool reads them.',
      ]);
    });
  });

  describe('withholding', () => {
    const leaky = 'https://shop.test/r/2?api_key=sk-LEAKYKEYabcdefghijklmnopqrstu';

    it('offers only URLs the model-visible transform leaves byte-identical', () => {
      expect(offerableUrl('https://shop.test/list?page=2', services())).toBe(true);
      expect(offerableUrl(leaky, services())).toBe(false);
    });

    it('withholds an altered URL as null, counts it, and never records it', async () => {
      const analysis = everyPart('collection', {
        links: [{ text: 'Leaky', url: leaky, kind: 'content', sameSite: true }],
        coverage: {
          shape_basis: 'collection: test',
          fetch_mode: 'http',
          links: { found: 2, shown: 1, withheld: 0, by_kind: { content: 1, record: 1 } },
          not_found: [],
          omitted: [],
        },
      });
      const run = buildServices({ runDir });
      const projection = await projectPage(
        { sourceId: 'S1', url: 'https://shop.test/list', title: null, page: stored(analysis) },
        'full',
        100_000,
        run,
      );
      recordDiscovered(run, 'S1', projection.model);

      expect(projection.model.links).toEqual([{ text: 'Leaky', url: null, kind: 'content' }]);
      expect((projection.model.coverage as { links: { withheld: number } }).links.withheld).toBe(1);
      expect(projection.stats.linksWithheld).toBe(1);
      expect(run.urlProvenance.has(leaky)).toBe(false);
      expect(run.urlProvenance.has('https://shop.test/r/1')).toBe(true);
    });

    it('records structured URL properties and URLs written in text as discovered', async () => {
      const run = buildServices({ runDir });
      const analysis = everyPart('detail', {
        structured: [
          { type: 'Product', from: 'json-ld', props: { url: 'https://shop.test/p/9', name: 'P' } },
        ],
        readableText: 'See https://docs.test/manual for details.',
      });
      const projection = await projectPage(
        { sourceId: 'S4', url: 'https://shop.test/x', title: null, page: stored(analysis) },
        'full',
        100_000,
        run,
      );
      recordDiscovered(run, 'S4', projection.model);

      expect(run.urlProvenance.explain('https://shop.test/p/9')?.origin).toEqual({
        kind: 'discovered',
        sourceId: 'S4',
        linkKind: 'structured',
      });
      expect(run.urlProvenance.explain('https://docs.test/manual')?.origin).toEqual({
        kind: 'discovered',
        sourceId: 'S4',
        linkKind: 'text',
      });
    });
  });

  describe('degradation', () => {
    /** A page with every part far over budget. */
    function heavy(): PageAnalysis {
      const record = (n: number) => ({
        key: `https://shop.test/r/${n}`,
        title: `Record number ${n} with a reasonably long title`,
        url: `https://shop.test/r/${n}`,
        segments: [`Segment text for record ${n} that carries a little weight`],
        fields: [],
        numbers: [],
        links: [],
      });
      return everyPart('collection', {
        records: Array.from({ length: 25 }, (_, n) => record(n + 1)),
        links: Array.from({ length: 40 }, (_, n) => ({
          text: `Link ${n}`,
          url: `https://shop.test/l/${n}`,
          kind: 'content' as const,
          sameSite: true,
        })),
        structured: Array.from({ length: 25 }, (_, n) => ({
          type: 'Product',
          from: 'json-ld' as const,
          props: { name: `Product ${n} with a description that is not short at all` },
        })),
        tables: [
          {
            index: 0,
            kind: 'data',
            caption: null,
            headers: ['a', 'b'],
            rows: Array.from({ length: 50 }, (_, n) => [`row ${n} cell a`, `row ${n} cell b`]),
          },
        ],
        readableText: Array.from({ length: 2_000 }, (_, n) => `word${n}`).join(' '),
      });
    }

    it('excerpts the text first and stops when that fits', async () => {
      const analysis = heavy();
      const full = await project(analysis);
      const fullBytes = Buffer.byteLength(JSON.stringify(full.model), 'utf8');
      // Room for the excerpt, its capture_ref, and the omission phrase that says so.
      const budget = fullBytes - analysis.readableText.length + EXCERPT_CHARS + 600;

      const projection = await project(analysis, 'full', budget);

      expect(projection.model.text).toBeUndefined();
      expect(projection.model.excerpt).toHaveLength(EXCERPT_CHARS);
      expect(projection.model.capture_ref).toBe(projection.textCaptureRef);
      expect((projection.model.links as unknown[]).length).toBe(40);
      expect((projection.model.coverage as { omitted: string[] }).omitted).toEqual([
        'The full text did not fit this result: a 1,000-character excerpt is shown, and the full text is stored with this run as capture_ref; no tool reads it back.',
      ]);
    });

    it('then trims links to 20 and 10, structured, table rows, and records, in that order', async () => {
      const projection = await project(heavy(), 'full', 4_000);
      const omitted = (projection.model.coverage as { omitted: string[] }).omitted;

      expect(Buffer.byteLength(JSON.stringify(projection.model), 'utf8')).toBeLessThanOrEqual(
        4_000,
      );
      expect((projection.model.links as unknown[]).length).toBe(10);
      expect(projection.model.structured).toBeUndefined();
      // Every row trimmed; the table's shell (index, headers) stays so its position is known.
      expect(
        (projection.model.tables as { rows: unknown[] }[]).every(
          (table) => table.rows.length === 0,
        ),
      ).toBe(true);
      expect((projection.model.records as unknown[]).length).toBeGreaterThan(0);
      expect((projection.model.records as unknown[]).length).toBeLessThan(25);
      expect(omitted.map((phrase) => phrase.split(' ')[1])).toEqual([
        'full',
        'links',
        'structured',
        'table',
        'records',
      ]);
      expect(omitted[1]).toMatch(/^30 links were trimmed/u);
      expect(omitted[2]).toMatch(/^25 structured entities were trimmed/u);
      expect(omitted[3]).toMatch(/^50 table rows were trimmed/u);
    });

    it('trims records from the end, keeping the first ones and their anchors', async () => {
      const projection = await project(heavy(), 'full', 4_000);
      const ids = (projection.model.records as { id: string }[]).map((record) => record.id);
      expect(ids[0]).toBe('S1#r1');
      expect(ids).toEqual(ids.map((_, index) => `S1#r${index + 1}`));
    });

    it('writes the full analysis once whenever anything was trimmed', async () => {
      const projection = await project(heavy(), 'full', 4_000);
      const files = await readdir(join(runDir, 'captures'));
      expect(projection.analysisCaptureRef).toMatch(/^cap-/u);
      expect(files.sort()).toEqual(
        [
          `${projection.analysisCaptureRef ?? ''}.txt`,
          `${projection.textCaptureRef ?? ''}.txt`,
        ].sort(),
      );
    });

    it('writes nothing when the view fits', async () => {
      const projection = await project(everyPart('collection'));
      expect(projection.analysisCaptureRef).toBeNull();
      expect(projection.textCaptureRef).toBeNull();
      await expect(readdir(join(runDir, 'captures'))).rejects.toThrow();
    });

    it('is deterministic', async () => {
      const first = await project(heavy(), 'full', 4_000);
      const second = await project(heavy(), 'full', 4_000);
      const strip = (model: Record<string, unknown>) => ({ ...model, capture_ref: undefined });
      expect(strip(second.model)).toEqual(strip(first.model));
    });
  });

  describe('summary view', () => {
    it('shows at most 5 records, 10 pagination/facet links, the excerpt, coverage, and a note', async () => {
      const analysis = everyPart('collection', {
        records: Array.from({ length: 8 }, (_, n) => ({
          key: `k${n}`,
          title: `R${n}`,
          url: null,
          segments: [],
          fields: [],
          numbers: [],
          links: [],
        })),
        links: [
          ...Array.from({ length: 12 }, (_, n) => ({
            text: `Facet ${n}`,
            url: `https://shop.test/list?f=${n}`,
            kind: 'facet' as const,
            sameSite: true,
          })),
          { text: 'Other', url: 'https://shop.test/about', kind: 'content', sameSite: true },
        ],
        readableText: 'x'.repeat(3_000),
      });

      const { model } = await project(analysis, 'summary');

      expect(Object.keys(model)).toEqual([
        'source_id',
        'url',
        'title',
        'shape',
        'records',
        'links',
        'excerpt',
        'coverage',
        'note',
      ]);
      expect(model.records).toHaveLength(5);
      expect(model.links).toHaveLength(10);
      expect((model.links as { kind: string }[]).every((link) => link.kind === 'facet')).toBe(true);
      expect(model.excerpt).toHaveLength(EXCERPT_CHARS);
      expect(model.note).toMatch(/web_fetch of this URL returns its full records/u);
    });

    it('splits the summary budget across fetched sites', () => {
      expect(summaryBudget(24 * 1024, 5)).toBe(Math.floor((0.8 * 24 * 1024) / 5));
      expect(fullViewBudget(24 * 1024)).toBe(Math.floor(0.9 * 24 * 1024));
    });
  });

  describe('fixture corpus through web_fetch at the default 24 KiB result size', () => {
    it.each([
      ['listing', listingHtml()],
      ['detail', detailHtml('Glacier White', 'Black Leather', 'Lakeside Motors')],
      ['article', articleHtml()],
      ['hub', hubHtml()],
      ['multi-table', multiTableHtml()],
      [
        'large article',
        articleHtml().replace('</article>', `<p>${'Long prose. '.repeat(4_000)}</p></article>`),
      ],
    ])('never reaches the middleware hard truncation (%s)', async (_name, html) => {
      const url = 'https://shop.test/page';
      const run = buildServices({
        runDir,
        urlProvenance: attestedHosts('shop.test'),
        fetch: {
          fetcher: { fetch: () => Promise.resolve(fetchedDoc({ url, finalUrl: url, html })) },
          extractor: new ReadabilityExtractor(),
        },
      });
      const result = await wrapTool(webFetchSpec(run), run).execute({ url }, undefined);

      expect(result.status).toBe('ok');
      expect(Buffer.byteLength(result.modelText, 'utf8')).toBeLessThan(
        run.budgets.maxBytesPerResult,
      );
      expect(() => JSON.parse(result.modelText) as unknown).not.toThrow();
    });

    it('treats an empty page as EXTRACTION_EMPTY', async () => {
      const url = 'https://shop.test/empty';
      const run = buildServices({
        runDir,
        urlProvenance: attestedHosts('shop.test'),
        fetch: {
          fetcher: {
            fetch: () => Promise.resolve(fetchedDoc({ url, finalUrl: url, html: emptyHtml() })),
          },
          extractor: new ReadabilityExtractor(),
        },
      });
      const result = await wrapTool(webFetchSpec(run), run).execute({ url }, undefined);
      expect(result.error_code).toBe('EXTRACTION_EMPTY');
    });
  });

  it('keeps provenance and the sanitizer on one transform', () => {
    // The offer check and the middleware share `modelVisibleText`, so a value
    // the sanitizer leaves alone is offerable under the same profile.
    const run = { sanitizer: new DefaultSanitizer(), urlProvenance: new UrlProvenance() };
    expect(offerableUrl('https://plain.test/a?b=c', run)).toBe(true);
  });
});
