/**
 * `listing-table`: the motivating task, adapted to the fixtures (plan §7
 * "Target trace").
 *
 * Discover the results page without fetching, read it as a collection, follow
 * the drivetrain facet the page offers, read the top three detail pages its
 * records link to, and publish one sourced row per item. Today most of that
 * trace is unreachable — no discovery mode, no records, no links — and the
 * `unreachable` list pins exactly which moves the tools did not offer (G3).
 */

import type { OfferedRecord, ScriptContext, ScriptStep } from '../agent/scripted-provider.js';
import {
  atLeast,
  equals,
  includesAll,
  matchesShape,
  satisfies,
  type Expectation,
} from '../expectations.js';
import {
  CANONICAL_FILTERS,
  INVENTORY,
  USER_LOCATION,
  truthRows,
  type FilterName,
} from '../fixtures/inventory.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario, ScenarioContract } from '../scenario.js';
import { scoreRun } from '../score/scorer.js';

import {
  arrayOf,
  briefOf,
  crossCuttingExpectations,
  fieldOf,
  maxRequestsPerUrl,
  outcomeOf,
  recordPrice,
  recordSeller,
  pageField,
  sourceIdOf,
  requestsDuring,
  resultLabelled,
  stringProp,
} from './common.js';

const LISTING_HOST = 'faceted-listing.yantra.test';
const QUERY = 'new 2026 Norvale Teyra Summit AWD near Fairview';
const DETAIL_COUNT = 5;

/** The listing read the detail records come from: the AWD facet page when followed, else the results page. */
function listingRead(ctx: ScriptContext): ReturnType<ScriptContext['last']> {
  return ctx.labelled('awd-facet')[0] ?? ctx.labelled('results')[0];
}
function deliveredRecords(ctx: ScriptContext): readonly OfferedRecord[] {
  return [
    ...ctx.recordsFrom(listingRead(ctx)),
    ...ctx.labelled('next-page').flatMap((result) => ctx.recordsFrom(result)),
  ].sort((a, b) => (recordPrice(a) ?? Infinity) - (recordPrice(b) ?? Infinity));
}

function detailStep(index: number): ScriptStep {
  return {
    kind: 'call',
    tool: 'web_fetch',
    label: `detail-${index + 1}`,
    params: (ctx) => {
      const record = deliveredRecords(ctx)[index];
      return typeof record?.url === 'string' ? { url: record.url } : null;
    },
  };
}

const script: readonly ScriptStep[] = [
  {
    kind: 'call',
    tool: 'task_contract',
    label: 'contract',
    params: {
      deliverable: 'table',
      subject: 'SUV listings',
      required_fields: ['seller', 'price', 'exterior color', 'interior color'],
      filters: Object.entries(CANONICAL_FILTERS).map(([name, value]) => ({ name, value })),
      required_sources: [LISTING_HOST],
      ranking: { field: 'price', direction: 'asc' },
      limit: 5,
    },
  },
  // Discovery: titles and URLs only, no page fetched (FEAT-050's `limit: 0`).
  {
    kind: 'call',
    tool: 'web_search',
    label: 'discover',
    params: { query: QUERY, limit: 0 },
  },
  // Today's engineered fallback when discovery is refused: an ordinary search
  // for one hit. Skipped — not unreachable — once discovery works.
  {
    kind: 'call',
    tool: 'web_search',
    label: 'search',
    params: { query: QUERY, limit: 1 },
    when: (ctx) => ctx.labelled('discover')[0]?.status !== 'ok',
  },
  {
    kind: 'call',
    tool: 'web_fetch',
    label: 'results',
    params: (ctx) => {
      const url = ctx.urlFromSearch(LISTING_HOST);
      return url === null ? null : { url };
    },
  },
  ...['New', 'Summit', 'AWD'].map((value, i): ScriptStep => ({
    kind: 'call',
    tool: 'web_fetch',
    label: i === 2 ? 'awd-facet' : `filter-${i}`,
    params: (ctx) => {
      const previous = ctx.labelled(i === 0 ? 'results' : `filter-${i - 1}`)[0];
      const link = ctx
        .linksOfKind('facet', previous)
        .find(
          (entry) =>
            entry.text.replace(/\s*\(\d+\)\s*$/u, '').toLowerCase() === value.toLowerCase(),
        );
      return link === undefined ? null : { url: link.url };
    },
  })),
  {
    kind: 'call',
    tool: 'web_fetch',
    label: 'next-page',
    params: (ctx) => {
      const link = ctx
        .linksOfKind('pagination', listingRead(ctx))
        .find((entry) => /^next\b/iu.test(entry.text));
      return link === undefined ? null : { url: link.url };
    },
    when: (ctx) =>
      ctx.linksOfKind('pagination', listingRead(ctx)).some((entry) => /^next\b/iu.test(entry.text)),
  },
  ...Array.from({ length: DETAIL_COUNT }, (_, index) => detailStep(index)),
  {
    kind: 'call',
    tool: 'result_publish',
    label: 'publish',
    params: (ctx) => {
      const records = deliveredRecords(ctx).slice(0, DETAIL_COUNT);
      const details = records.map((_, i) => ctx.labelled(`detail-${i + 1}`)[0]);
      if (records.length === 0 || details.some((result) => sourceIdOf(result) === null))
        return null;
      return {
        brief: {
          title: 'Norvale Teyra listings near Fairview',
          overview: 'Collected listing and detail pages from the required source.',
          table: {
            columns: ['seller', 'price', 'exterior color', 'interior color'],
            rows: records.map((record, i) => [
              recordSeller(record),
              recordPrice(record),
              pageField(details[i], 'Exterior color'),
              pageField(details[i], 'Interior color'),
            ]),
            row_sources: records.map((record, i) => [record.id, sourceIdOf(details[i])!]),
          },
          constraints: [
            {
              name: 'drivetrain',
              value: 'AWD',
              status: 'verified',
              sources: details.map((result) => sourceIdOf(result)!),
            },
          ],
        },
      };
    },
  },
];

/** Records offered by the results read, or null when the result carries no `records`. */
function resultsRecords(run: Parameters<Expectation['measure']>[0]): readonly unknown[] | null {
  return arrayOf(resultLabelled(run, 'results'), 'records');
}

const firstItem = INVENTORY[0];

/** The faithful answer: new 2026 Summit AWD rows from the required site, cheapest five. */
const CONTRACT: ScenarioContract = {
  deliverable: 'table',
  requiredFields: ['seller', 'price', 'exteriorColor', 'interiorColor'],
  filters: (Object.keys(CANONICAL_FILTERS) as FilterName[]).map((name) => ({
    name,
    value: CANONICAL_FILTERS[name],
  })),
  requiredSources: [LISTING_HOST],
  ranking: { field: 'price', order: 'asc' },
  limit: 5,
};

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'discovery-fetches-nothing',
    owner: 'FEAT-050',
    measure: (run) => {
      const discover = resultLabelled(run, 'discover');
      return { ...outcomeOf(discover), requests: requestsDuring(run, discover) };
    },
    target: equals({ status: 'ok', errorCode: null, requests: 0 }),
    note: 'G5: `web_search {limit: 0}` discovers URLs, charging no navigation and fetching no page.',
  },
  {
    id: 'one-request-per-url',
    owner: 'FEAT-050',
    measure: (run) => maxRequestsPerUrl(run),
    target: equals(1),
    note: 'G5 / §11 "network fetches per URL per run": the results page is fetched once.',
  },
  {
    id: 'results-read-as-collection',
    owner: 'FEAT-051',
    measure: (run) => ({
      shape: fieldOf(resultLabelled(run, 'results'), 'shape'),
      records: resultsRecords(run)?.length ?? null,
    }),
    target: equals({ shape: 'collection', records: 6 }),
    note: 'G2: the results page reads as a collection of its 6 cards.',
  },
  {
    id: 'records-carry-card-fields',
    owner: 'FEAT-051',
    measure: (run) => {
      const records = resultsRecords(run);
      if (records === null) return null;
      const pageOne = truthRows().slice(0, 6);
      return records.filter((record) => {
        const text = JSON.stringify(record);
        const row = pageOne.find((candidate) => text.includes(candidate.fields.seller));
        return (
          row !== undefined &&
          typeof (record as { url?: unknown }).url === 'string' &&
          text.includes(row.fields.title) &&
          text.includes(row.fields.price) &&
          text.includes(row.fields.distance)
        );
      }).length;
    },
    target: equals(6),
    note: 'G2: each record carries title, price, seller, distance, and its link.',
  },
  {
    id: 'g2-card-keeps-its-seller',
    owner: 'FEAT-051',
    measure: (run) => {
      const records = resultsRecords(run);
      const seller = firstItem?.seller;
      if (records === null || seller === undefined) return null;
      return records.some((record) => JSON.stringify(record).includes(seller));
    },
    target: equals(true),
    note: 'G2 regression card: a plain-text price with linked title and seller keeps the seller.',
  },
  {
    id: 'awd-facet-link-offered',
    owner: 'FEAT-051',
    measure: (run) => {
      const links = arrayOf(resultLabelled(run, 'results'), 'links');
      return links === null
        ? null
        : links.filter(
            (link) =>
              stringProp(link, 'kind') === 'facet' && /^AWD\b/i.test(stringProp(link, 'text')),
          ).length;
    },
    target: atLeast(1),
    note: 'G3: the drivetrain facet is offered as a `facet` link.',
  },
  {
    id: 'detail-reads-carry-colors',
    owner: 'FEAT-051',
    measure: (run) =>
      Array.from({ length: DETAIL_COUNT }, (_, i) => i + 1).filter((index) => {
        const read = resultLabelled(run, `detail-${index}`);
        if (read?.status !== 'ok') return false;
        return truthRows().some(
          (row) =>
            read.modelText.includes(row.fields.exteriorColor) &&
            read.modelText.includes(row.fields.interiorColor) &&
            read.modelText.includes(row.fields.seller),
        );
      }).length,
    target: equals(DETAIL_COUNT),
    note: 'G3: the top detail pages are reachable and return their colors.',
  },
  {
    id: 'no-unreachable-moves',
    owner: 'FEAT-051',
    measure: (run) => run.unreachable,
    target: equals([]),
    note: 'G3 / §11 "turns spent seeking unreachable URLs": every move in the trace is offered.',
  },
  {
    id: 'research-can-browse',
    owner: 'FEAT-052',
    measure: (run) => run.registeredTools,
    target: includesAll(['browser_extract', 'browser_navigate', 'browser_observe']),
    note: 'G1: `research` registers read-only browsing by default.',
  },
  {
    id: 'comparison-table-cited-per-row',
    owner: 'FEAT-053',
    measure: (run) => {
      const comparison = (briefOf(run)?.facets as { comparison?: unknown } | undefined)
        ?.comparison as { rows?: unknown; row_citations?: unknown } | undefined;
      return {
        rows: Array.isArray(comparison?.rows) ? comparison.rows.length : null,
        rowCitations: Array.isArray(comparison?.row_citations)
          ? comparison.row_citations.length
          : null,
      };
    },
    target: satisfies('a comparison table with one citation list per row', (value) => {
      const { rows, rowCitations } = value as { rows: number | null; rowCitations: number | null };
      return rows !== null && rows > 0 && rowCitations === rows;
    }),
    note: 'G7: the Brief carries a comparison table with `row_citations`.',
  },
  {
    id: 'drivetrain-constraint-verified',
    owner: 'FEAT-053',
    measure: (run) => {
      const constraints = briefOf(run)?.constraints;
      if (!Array.isArray(constraints)) return null;
      const drivetrain: unknown = constraints.find((entry: unknown) =>
        /drivetrain/i.test(stringProp(entry, 'name')),
      );
      return drivetrain === undefined ? null : stringProp(drivetrain, 'status');
    },
    target: equals('verified'),
    note: '§11 "unverified constraints asserted as fact": AWD appears in `constraints[]` as verified.',
  },
  {
    id: 'reaches-the-results-page',
    owner: 'current',
    measure: (run) => outcomeOf(resultLabelled(run, 'results')),
    target: matchesShape({ status: 'ok' }),
    note: 'The results page is reachable from search evidence alone (no invented URL).',
  },
  {
    id: 'field-coverage-oracle',
    owner: 'FEAT-053',
    // The scorer itself, on this deterministic run: proves end to end that a
    // correct run can reach plan §11's "≥ 90% of requested cells" target.
    measure: (run) => scoreRun(run, { contract: CONTRACT }, truthRows()).field_coverage.value,
    target: atLeast(0.9),
    note: '§11 "requested cells delivered from the required source": ≥ 90% on this scenario.',
  },
];

export const listingTable: Scenario = {
  id: 'listing-table',
  sites: ['faceted-listing'],
  command: 'research',
  goal:
    'List dealer, lowest price, exterior and interior color for new 2026 Norvale Teyra Summit ' +
    'in AWD near me. Use faceted-listing.yantra.test',
  contract: CONTRACT,
  userLocation: USER_LOCATION,
  serps: [
    {
      match: /teyra|norvale|faceted-listing/i,
      results: [
        { url: `${originOf('faceted-listing')}/new/results`, title: 'Norvale Teyra for sale' },
        { url: `${originOf('structured-listing')}/results`, title: 'Norvale Teyra inventory' },
      ],
    },
  ],
  script,
  expectations,
  tiers: ['deterministic', 'agentic'],
  truth: () => truthRows(),
};
