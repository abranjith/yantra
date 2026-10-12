/**
 * The model-visible view of a shape-aware page read (FEAT-051), and the URL
 * provenance it earns.
 *
 * A page read now offers links, record URLs, and structured URL properties,
 * and each becomes navigable because the page attested it (G3). Two rules keep
 * that safe:
 *
 * - **Offer only what survives intact.** A URL is offered only when the
 *   middleware's model-visible transform (user-input mask, then the `public`
 *   sanitizer) leaves it byte-identical, so the URL the model copies is
 *   exactly the URL that was recorded. Anything else is withheld (`url: null`)
 *   and counted.
 * - **Record only what was shown.** {@link recordDiscovered} walks the payload
 *   the model will actually read, so a link trimmed by a bound is never
 *   attested until a later view shows it.
 */

import type {
  LinkKind,
  Omission,
  PageAnalysis,
  PageCoverage,
  PageField,
  PageRecord,
  PageShape,
  StoredPage,
} from '@yantra/core';

import { renderAgentMessage } from '../../../runtime/messages.js';
import { modelVisibleText } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { extractUrls, type ProvenanceOrigin } from '../../../runtime/url-provenance.js';

import { writeCapture } from './capture.js';

/** The services a payload check needs: exactly the model-visible transform's inputs. */
export type PayloadServices = Pick<RunServices, 'userInput' | 'modelValues' | 'sanitizer'>;

/**
 * Whether a URL reaches the model byte-identical. The URL is checked as a JSON
 * string, the form it takes inside a tool payload, so an escape or redaction
 * that only happens in that context is caught too.
 *
 * @param url - An absolute URL the page offers.
 * @param services - The run's sanitizer and user-input vault.
 */
export function offerableUrl(url: string, services: PayloadServices): boolean {
  const serialized = JSON.stringify([url]);
  return modelVisibleText([url], 'public', services).text === serialized;
}

/** The URL-bearing members of a page payload, in its wire form. */
export interface DiscoverablePayload {
  readonly links?: readonly { readonly url: string | null; readonly kind?: string }[];
  readonly records?: readonly {
    readonly url?: string | null;
    readonly links?: readonly { readonly url: string | null }[];
  }[];
  readonly structured?: readonly { readonly props: Readonly<Record<string, unknown>> }[];
  readonly text?: string;
  readonly excerpt?: string;
}

const LINK_KINDS: ReadonlySet<string> = new Set([
  'pagination',
  'facet',
  'record',
  'content',
  'navigation',
]);

/**
 * Records, as `discovered` from `sourceId`, every URL the payload shows the
 * model: offered links (with their kind), record URLs and record links,
 * absolute http(s) structured properties, and URLs written in returned text.
 * Withheld (`null`) URLs and URLs that would not survive the model-visible
 * transform are skipped, so nothing the model was not shown is attested.
 *
 * @param services - The run services (provenance plus the transform's inputs).
 * @param sourceId - The evidence ID of the page that offered the URLs.
 * @param payload - The projected payload, exactly as the model will read it.
 * @returns The number of URLs recorded.
 */
export function recordDiscovered(
  services: PayloadServices & Pick<RunServices, 'urlProvenance'>,
  sourceId: string,
  payload: DiscoverablePayload,
): number {
  let recorded = 0;
  const record = (
    url: string | null | undefined,
    linkKind: LinkKind | 'text' | 'structured',
  ): void => {
    // A whole value that is one absolute http(s) URL, never a URL-led sentence.
    if (typeof url !== 'string' || !/^https?:\/\/\S+$/iu.test(url)) return;
    if (!offerableUrl(url, services)) return;
    const origin: ProvenanceOrigin = { kind: 'discovered', sourceId, linkKind };
    services.urlProvenance.record(url, origin);
    recorded += 1;
  };
  for (const link of payload.links ?? []) {
    const kind =
      link.kind !== undefined && LINK_KINDS.has(link.kind) ? (link.kind as LinkKind) : 'content';
    record(link.url, kind);
  }
  for (const entry of payload.records ?? []) {
    record(entry.url, 'record');
    for (const link of entry.links ?? []) record(link.url, 'content');
  }
  for (const entity of payload.structured ?? []) {
    for (const value of Object.values(entity.props)) {
      if (typeof value === 'string') record(value.trim(), 'structured');
    }
  }
  for (const text of [payload.text, payload.excerpt]) {
    for (const url of extractUrls(text ?? '')) record(url, 'text');
  }
  return recorded;
}

/** Characters of page content offered as the ledger excerpt (the ledger bounds it further). */
const EVIDENCE_EXCERPT_CHARS = 1_000;

/**
 * The ledger excerpt for a page, by shape: an article's own excerpt as before;
 * a collection's first three records; a detail page's first fields; a table
 * page's first table; an index page's readable text. One rule for every tool
 * that reads a page through the analyzer.
 *
 * @param page - The page analysis.
 * @param articleExcerpt - Readability's excerpt, when the page has an article.
 */
export function evidenceExcerpt(page: PageAnalysis, articleExcerpt: string | null): string {
  let excerpt: string;
  switch (page.shape) {
    case 'collection':
      excerpt =
        page.records.length > 0
          ? page.records
              .slice(0, 3)
              .map((entry) => [entry.title ?? '', ...entry.segments].filter(Boolean).join(' · '))
              .join('\n')
          : page.readableText;
      break;
    case 'detail':
      excerpt =
        page.fields.length > 0
          ? page.fields.map((field) => `${field.label}: ${field.value}`).join('\n')
          : page.readableText;
      break;
    case 'table': {
      const [first] = page.tables;
      excerpt =
        first === undefined
          ? page.readableText
          : [first.headers, ...first.rows].map((row) => row.join(' | ')).join('\n');
      break;
    }
    case 'article':
      excerpt = articleExcerpt ?? page.readableText;
      break;
    default:
      excerpt = page.readableText;
  }
  return excerpt.slice(0, EVIDENCE_EXCERPT_CHARS);
}

/** Which view of a page to project. */
export type PageView = 'full' | 'summary';

/** The page to project and its identity. */
export interface ProjectPageInput {
  /** The page's evidence ID; null for a live page that is not a source (no http(s) URL). */
  readonly sourceId: string | null;
  readonly url: string;
  readonly title: string | null;
  readonly page: StoredPage;
}

/** A projected page, ready to return as a tool's model payload. */
export interface PageProjection {
  /** The model-visible object, within the byte budget. */
  readonly model: Record<string, unknown>;
  /** The capture holding the full text, when the text was excerpted. */
  readonly textCaptureRef: string | null;
  /** The capture holding the full analysis JSON, when any part was trimmed. */
  readonly analysisCaptureRef: string | null;
  /** Counters for run health. */
  readonly stats: {
    readonly recordsShown: number;
    readonly linksOffered: number;
    readonly linksWithheld: number;
  };
}

/** Characters of text a degraded or summary view keeps. */
export const EXCERPT_CHARS = 1_000;

/** Records a search summary shows. */
export const SUMMARY_RECORDS = 5;

/** Pagination/facet links a search summary shows. */
export const SUMMARY_LINKS = 10;

/** Link counts tried, in order, when a full view must shrink. */
const LINK_STEPS: readonly number[] = [20, 10];

/** Secondary parts of a full view, in their fixed order (text always last). */
const SECONDARY_ORDER = ['fields', 'tables', 'structured', 'records', 'links'] as const;

/** The primary part each shape leads with. */
const PRIMARY: Readonly<Record<PageShape, (typeof SECONDARY_ORDER)[number] | 'text'>> = {
  collection: 'records',
  table: 'tables',
  detail: 'fields',
  article: 'text',
  index: 'links',
};

/** The byte budget of a full view: 90% of a result, leaving headroom for sanitizer growth. */
export function fullViewBudget(maxBytesPerResult: number): number {
  return Math.floor(0.9 * maxBytesPerResult);
}

/** The byte budget of one site's summary in a search result. */
export function summaryBudget(maxBytesPerResult: number, fetchedSites: number): number {
  return Math.floor((0.8 * maxBytesPerResult) / Math.max(1, fetchedSites));
}

/**
 * Project a stored page onto the model-visible object.
 *
 * - `full` (`web_fetch`, `browser_extract`): identity, `shape`, the shape's
 *   primary part, then `fields`, `tables`, `structured`, `records`, `links`,
 *   then `text` (or `excerpt` + `capture_ref`), then `coverage`.
 * - `summary` (`web_search` sites): identity, `shape`, at most 5 records, at
 *   most 10 pagination/facet links, the excerpt, `coverage`, and a note that
 *   `web_fetch` of the URL returns the full view from the store.
 *
 * The candidate is measured in UTF-8 bytes and degraded deterministically until
 * it fits `budgetBytes`: text → excerpt + capture; links → 20 → 10; then
 * structured entities, table rows, and records from the end, one at a time.
 * Every trim is stated in `coverage.omitted`, and the full analysis is captured
 * once whenever anything was trimmed, so nothing is lost from the run.
 *
 * @param input - The page and its identity.
 * @param view - Which view to project.
 * @param budgetBytes - The byte budget for the object.
 * @param services - The run services (sanitizer inputs and run directory).
 * @param parts - Restrict a full view to some parts (a `browser_extract` kind).
 */
export async function projectPage(
  input: ProjectPageInput,
  view: PageView,
  budgetBytes: number,
  services: PayloadServices & Pick<RunServices, 'runDir'>,
  parts?: ReadonlySet<'records' | 'links' | 'structured' | 'tables' | 'fields' | 'text'>,
): Promise<PageProjection> {
  const { analysis, anchors } = input.page;
  let withheld = 0;
  const offer = (url: string | null): string | null => {
    if (url === null) return null;
    if (offerableUrl(url, services)) return url;
    withheld += 1;
    return null;
  };

  const allRecords = analysis.records.map((record) =>
    recordWire(
      record,
      input.sourceId === null ? null : `${input.sourceId}#r${anchors.get(record.key) ?? 0}`,
      offer,
    ),
  );
  const allLinks = analysis.links.map((link) => ({
    text: link.text,
    url: offer(link.url),
    kind: link.kind,
  }));
  const allStructured = analysis.structured.map((entity) => ({
    type: entity.type,
    from: entity.from,
    props: Object.fromEntries(
      Object.entries(entity.props).map(([key, value]) => [
        key,
        typeof value === 'string' && /^https?:\/\/\S+$/iu.test(value.trim()) ? offer(value) : value,
      ]),
    ),
  }));
  const allTables = analysis.tables.map((table) => ({
    index: table.index,
    kind: table.kind,
    caption: table.caption,
    headers: [...table.headers],
    rows: table.rows.map((row) => [...row]),
  }));
  const fields = fieldRecord(analysis.fields);
  const text = analysis.readableText;
  const want = (part: 'records' | 'links' | 'structured' | 'tables' | 'fields' | 'text'): boolean =>
    parts === undefined || parts.has(part);

  // The mutable degradation state.
  const state = {
    excerpt: view === 'summary',
    links: view === 'summary' ? SUMMARY_LINKS : allLinks.length,
    structured: allStructured.length,
    rows: allTables.map((table) => table.rows.length),
    records: view === 'summary' ? Math.min(SUMMARY_RECORDS, allRecords.length) : allRecords.length,
  };
  const summaryLinks = allLinks.filter(
    (link) => link.kind === 'pagination' || link.kind === 'facet',
  );
  const trims = { text: false, links: 0, structured: 0, rows: 0, records: 0 };
  let textCaptureRef: string | null = null;

  const assemble = (): Record<string, unknown> => {
    const linkPool = view === 'summary' ? summaryLinks : allLinks;
    const present: Record<string, unknown> = {
      records: want('records') ? allRecords.slice(0, state.records) : [],
      links: want('links') ? linkPool.slice(0, state.links) : [],
      structured: want('structured') ? allStructured.slice(0, state.structured) : [],
      tables: want('tables')
        ? allTables.map((table, position) => ({
            ...table,
            rows: table.rows.slice(0, state.rows[position] ?? table.rows.length),
          }))
        : [],
      fields: want('fields') ? fields : {},
    };
    const model: Record<string, unknown> = {
      ...(input.sourceId === null ? {} : { source_id: input.sourceId }),
      url: input.url,
      title: input.title,
      shape: analysis.shape,
    };
    if (analysis.shape === 'article' && input.page.article !== null && view === 'full') {
      model.byline = input.page.article.byline;
      model.published_at = input.page.article.publishedAt;
    }
    const textPart = (): void => {
      if (!want('text') || text.length === 0) return;
      if (state.excerpt) {
        model.excerpt = text.slice(0, EXCERPT_CHARS);
        if (textCaptureRef !== null) model.capture_ref = textCaptureRef;
      } else {
        model.text = text;
      }
    };
    const primary = analysis.shape === null ? null : PRIMARY[analysis.shape];
    if (view === 'full') {
      if (primary === 'text') textPart();
      else if (primary !== null && !isEmpty(present[primary])) model[primary] = present[primary];
      for (const part of SECONDARY_ORDER) {
        if (part !== primary && !isEmpty(present[part])) model[part] = present[part];
      }
      if (primary !== 'text') textPart();
    } else {
      for (const part of ['records', 'links'] as const) {
        if (!isEmpty(present[part])) model[part] = present[part];
      }
      textPart();
    }
    const textShown = !want('text')
      ? 0
      : state.excerpt
        ? Math.min(text.length, EXCERPT_CHARS)
        : text.length;
    model.coverage = coverageWire(analysis.coverage, trims, withheld, textShown);
    if (view === 'summary') model.note = renderAgentMessage('tool', 'WEB_READ', 'page-summary');
    return model;
  };

  const fits = (): boolean => Buffer.byteLength(JSON.stringify(assemble()), 'utf8') <= budgetBytes;

  if (!fits() && !state.excerpt && want('text') && text.length > EXCERPT_CHARS) {
    textCaptureRef = await writeCapture(services.runDir, text);
    state.excerpt = true;
    trims.text = true;
  }
  for (const step of LINK_STEPS) {
    if (fits() || state.links <= step) continue;
    trims.links += state.links - step;
    state.links = step;
  }
  while (!fits() && state.structured > 0) {
    state.structured -= 1;
    trims.structured += 1;
  }
  for (let position = state.rows.length - 1; position >= 0; position -= 1) {
    while (!fits() && (state.rows[position] ?? 0) > 0) {
      state.rows[position] = (state.rows[position] ?? 0) - 1;
      trims.rows += 1;
    }
  }
  while (!fits() && state.records > 0) {
    state.records -= 1;
    trims.records += 1;
  }

  const trimmed = trims.links + trims.structured + trims.rows + trims.records > 0 || trims.text;
  const analysisCaptureRef = trimmed
    ? await writeCapture(services.runDir, JSON.stringify(analysis))
    : null;
  const model = assemble();
  return {
    model,
    textCaptureRef,
    analysisCaptureRef,
    stats: {
      recordsShown: Array.isArray(model.records) ? model.records.length : 0,
      linksOffered: Array.isArray(model.links)
        ? (model.links as { url: string | null }[]).filter((link) => link.url !== null).length
        : 0,
      linksWithheld: withheld,
    },
  };
}

/** A record's wire form; empty members are omitted and a repeated field label gets ` (2)`. */
function recordWire(
  record: PageRecord,
  id: string | null,
  offer: (url: string | null) => string | null,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    ...(id === null ? {} : { id }),
    title: record.title,
    url: offer(record.url),
  };
  if (record.segments.length > 0) wire.text = [...record.segments];
  if (record.fields.length > 0) wire.fields = fieldRecord(record.fields);
  if (record.numbers.length > 0) {
    wire.numbers = record.numbers.map((token) => ({ kind: token.kind, text: token.text }));
  }
  if (record.links.length > 0) {
    wire.links = record.links.map((link) => ({ text: link.text, url: offer(link.url) }));
  }
  return wire;
}

/** Label/value pairs as an object; later copies of a label get ` (2)`, ` (3)`, … */
function fieldRecord(fields: readonly PageField[]): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const field of fields) {
    const count = (seen.get(field.label) ?? 0) + 1;
    seen.set(field.label, count);
    out[count === 1 ? field.label : `${field.label} (${count})`] = field.value;
  }
  return out;
}

/** Coverage as the model reads it: omissions rendered through the registered templates. */
function coverageWire(
  coverage: PageCoverage,
  trims: {
    readonly text: boolean;
    readonly links: number;
    readonly structured: number;
    readonly rows: number;
    readonly records: number;
  },
  withheld: number,
  textShown: number,
): Record<string, unknown> {
  const omitted = coverage.omitted.map(renderOmission);
  if (trims.text) omitted.push(renderAgentMessage('tool', 'PAGE_COVERAGE', 'text-excerpted'));
  for (const [cause, count] of [
    ['links-trimmed', trims.links],
    ['structured-trimmed', trims.structured],
    ['table-rows-trimmed', trims.rows],
    ['records-trimmed', trims.records],
  ] as const) {
    if (count > 0) omitted.push(renderAgentMessage('tool', 'PAGE_COVERAGE', cause, { count }));
  }
  return {
    ...coverage,
    ...(coverage.links === undefined ? {} : { links: { ...coverage.links, withheld } }),
    ...(coverage.text === undefined ? {} : { text: { ...coverage.text, shown: textShown } }),
    omitted,
  };
}

/** One core omission, rendered through its registered template. */
export function renderOmission(omission: Omission): string {
  switch (omission.id) {
    case 'records-beyond-limit':
      return renderAgentMessage('tool', 'PAGE_COVERAGE', omission.id, {
        count: omission.count,
        pagination: omission.paginationOffered === true,
      });
    case 'table-rows-beyond-limit':
    case 'table-columns-beyond-limit':
      return renderAgentMessage('tool', 'PAGE_COVERAGE', omission.id, {
        count: omission.count,
        table: omission.table ?? 0,
      });
    default:
      return renderAgentMessage('tool', 'PAGE_COVERAGE', omission.id, { count: omission.count });
  }
}

function isEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0;
  return value === undefined || value === null;
}
