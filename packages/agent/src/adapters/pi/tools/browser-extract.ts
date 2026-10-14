import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  analyzeLivePage,
  classifyResponse,
  normalizeExtractedText,
  type AgentBrowserController,
  type PageSnapshot,
  type PageExtraction,
  type PageAnalysis,
  type PageLink,
} from '@yantra/core';
import { generateUlid } from '@yantra/protocol';
import { Type, type Static } from 'typebox';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { browserController, browserFailure, isDomainFailure } from './browser-common.js';
import { knownPageChallenge, recordPageChallenge } from './page-challenge.js';
import {
  evidenceExcerpt,
  fullViewBudget,
  projectPage,
  recordDiscovered,
  type ProjectPageInput,
} from './page-payload.js';

/**
 * What `browser_extract` can read from the live page (FEAT-051). `content` is
 * the rendered title and text; every other kind is read from a snapshot of the
 * page through the same core analyzer `web_fetch` uses, so a record, link, or
 * table means the same thing on both paths.
 */
type ExtractionKind = 'content' | 'records' | 'links' | 'structured' | 'tables' | 'table';

/**
 * Canonical kinds plus the near-miss words models actually emit.
 *
 * The Pi SDK validates tool arguments against this schema BEFORE the Yantra
 * middleware runs, so a closed literal union fails there with "kind: must be
 * equal to constant" — an error that never names the accepted values. A small
 * model then has no recovery path (observed: `kind:"text"` rejected, retried,
 * and the run finally invented a result). Accepting a plain string keeps the
 * decision inside the tool, where an unknown kind is refused with a message
 * that lists what IS accepted and the obvious synonyms simply resolve.
 */
const EXTRACTION_KINDS: Readonly<Record<string, ExtractionKind>> = {
  content: 'content',
  text: 'content',
  page: 'content',
  body: 'content',
  article: 'content',
  readable: 'content',
  readable_content: 'content',
  page_content: 'content',
  records: 'records',
  listings: 'records',
  items: 'records',
  results: 'records',
  links: 'links',
  urls: 'links',
  structured: 'structured',
  json_ld: 'structured',
  jsonld: 'structured',
  schema: 'structured',
  tables: 'tables',
  table: 'table',
  first_table: 'table',
};

const BrowserExtractParams = Type.Object(
  {
    kind: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'What to read from the current page: "content" (title + readable text, the default), ' +
          '"records" (repeated listing/result items), "links" (pagination, facet, and detail ' +
          'links), "structured" (schema.org data), "tables" (every table), or "table" with ' +
          '"index" (one table by its 0-based position).',
      }),
    ),
    index: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 1000,
        description: 'With kind "table": which table, counting from 0 in page order.',
      }),
    ),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserExtractParams>;

/** The resolved request: a kind, and for `table` the index (0 for `first_table`). */
interface ResolvedKind {
  readonly kind: ExtractionKind;
  readonly index: number;
}

/** A request for a part of the analyzed page (every kind but `content`). */
interface PartRequest extends ResolvedKind {
  readonly kind: Exclude<ExtractionKind, 'content'>;
}

/** Resolve a model-supplied kind to a canonical one; null when unsupported. */
function resolveKind(raw: string | undefined, index: number | undefined): ResolvedKind | null {
  if (raw === undefined) return { kind: 'content', index: 0 };
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const kind = EXTRACTION_KINDS[normalized];
  return kind === undefined ? null : { kind, index: index ?? 0 };
}

/** Build the typed current-page extraction tool. */
export function browserExtractSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserExtractParams> {
  return {
    name: 'browser_extract',
    label: 'Browser Extract',
    description:
      'Read the current page with a validated result shape. kind:"content" (the default) returns ' +
      'the title and readable text; kind:"records" returns repeated listing or result items; ' +
      'kind:"links" returns the pagination, facet, and detail links the page offers; ' +
      'kind:"structured" returns schema.org data; kind:"tables" returns every table, and ' +
      'kind:"table" with index:n returns one. Every kind except links records the page as a ' +
      'source. Do NOT pass arbitrary selectors or ask for unsanitized page source.',
    parameters: BrowserExtractParams,
    sanitizationProfile: 'public',
    budgetMeter: true,
    run: (params: Params, ctx): Promise<DomainResult> => runExtract(params, ctx.services),
  };
}

async function runExtract(params: Params, services: RunServices): Promise<DomainResult> {
  // Input first: an unsupported kind is the model's mistake to correct, and it
  // must be reported the same way whether or not a browser is configured.
  const resolved = resolveKind(params.kind, params.index);
  if (resolved === null)
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: renderAgentMessage('tool', 'INVALID_INPUT', 'extraction-kind', {
        kind: params.kind ?? '',
      }),
      retryable: true,
    };
  const deps = services.domain.browser;
  const controller = browserController(services);
  if (!deps || isDomainFailure(controller))
    return isDomainFailure(controller)
      ? controller
      : {
          ok: false,
          errorCode: 'BROWSER_UNAVAILABLE',
          message: renderAgentMessage('tool', 'BROWSER_UNAVAILABLE', 'services-missing'),
          retryable: false,
        };
  const challenged = knownPageChallenge(services, controller.url());
  if (challenged !== null) {
    services.runHealth.recordMemoHit();
    return challenged;
  }
  let snapshot: PageSnapshot;
  try {
    snapshot = await controller.snapshot();
  } catch (error) {
    return browserFailure(error);
  }
  if (!validSnapshot(snapshot))
    return {
      ok: false,
      errorCode: 'EXTRACTION_SCHEMA_INVALID',
      retryable: true,
      message: renderAgentMessage('tool', 'EXTRACTION_SCHEMA_INVALID', 'invalid-extraction', {
        kind: resolved.kind,
      }),
    };
  // The page may have redirected since controller.url() was read.
  const finalChallenge = knownPageChallenge(services, snapshot.url);
  if (finalChallenge !== null) {
    services.runHealth.recordMemoHit();
    return finalChallenge;
  }
  const classified = classifyResponse({ html: snapshot.html, contentType: 'text/html' });
  if (classified.kind === 'challenge')
    return recordPageChallenge(services, snapshot.url, classified.marker);
  const extraction = await analyzeLivePage(
    { extractor: services.domain.fetch.extractor },
    snapshot,
  );
  if (resolved.kind === 'content')
    return extractContent(snapshot, extraction, controller, services);
  return extractPart(
    { kind: resolved.kind, index: resolved.index },
    snapshot,
    extraction,
    controller,
    services,
  );
}

/** `content`: the rendered title and block-structured text. */
async function extractContent(
  snapshot: PageSnapshot,
  extraction: PageExtraction,
  controller: AgentBrowserController,
  services: RunServices,
): Promise<DomainResult> {
  const deps = services.domain.browser;
  const host = controller.host();
  const extracted = { title: snapshot.title, text: normalizeExtractedText(snapshot.visibleText) };
  services.trace?.append({
    kind: 'extract',
    host,
    extractionKind: 'content',
    requires_confirmation: false,
  });
  const sourceId = recordContentEvidence(extracted, snapshot.url, services);
  if (sourceId !== null) {
    services.urlProvenance.record(snapshot.url, { kind: 'tool', tool: 'browser_extract' });
    services.documents.attachPage(
      sourceId,
      { ...extraction.page, readableText: extracted.text },
      {
        delivered: 'partial',
        article: extraction.article,
      },
    );
    recordDiscovered(services, sourceId, { text: extracted.text });
  }
  const identity = sourceId === null ? {} : { source_id: sourceId, url: snapshot.url };
  const serialized = JSON.stringify(extracted);
  if (deps === null || Buffer.byteLength(serialized, 'utf8') <= deps.captureThresholdBytes)
    return { ok: true, model: { ...extracted, ...identity } };
  const captureRef = `cap-${generateUlid()}`;
  const captureDir = join(services.runDir, 'captures');
  await mkdir(captureDir, { recursive: true });
  await writeFile(join(captureDir, `${captureRef}.json`), serialized, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return {
    ok: true,
    model: {
      capture_ref: captureRef,
      preview: { title: extracted.title, text: extracted.text.slice(0, EVIDENCE_EXCERPT_CHARS) },
      ...identity,
    },
    details: { capture_ref: captureRef },
  };
}

/**
 * Every other kind: snapshot → challenge check → the core analyzer → the
 * run's document store → the requested part of the full view.
 */
async function extractPart(
  resolved: PartRequest,
  snapshot: PageSnapshot,
  extraction: PageExtraction,
  controller: AgentBrowserController,
  services: RunServices,
): Promise<DomainResult> {
  const host = controller.host();
  const page = extraction.page;

  if (resolved.kind === 'table' && resolved.index >= page.tables.length) {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: renderAgentMessage('tool', 'INVALID_INPUT', 'table-index', {
        count: page.tables.length,
        index: resolved.index,
      }),
      retryable: true,
      details: { count: page.tables.length },
    };
  }

  services.trace?.append({
    kind: 'extract',
    host,
    extractionKind: replayableKind(resolved),
    requires_confirmation: false,
  });

  // The live page is a source when it has an http(s) URL. The store keeps its
  // anchors, so re-reading the page never renumbers a record already cited.
  const isWebPage = /^https?:\/\//iu.test(snapshot.url);
  const record = isWebPage
    ? services.documents.observe(snapshot.url, {
        title: snapshot.title.length > 0 ? snapshot.title : null,
        tool: 'browser_extract',
      })
    : null;
  const article =
    extraction.article === null
      ? null
      : { byline: extraction.article.byline, publishedAt: extraction.article.publishedAt };
  const stored =
    record === null
      ? null
      : services.documents.attachPage(record.sourceId, page, { delivered: 'partial', article });
  if (record !== null)
    services.urlProvenance.record(snapshot.url, { kind: 'tool', tool: 'browser_extract' });

  const view = viewFor(resolved, page);
  const input: ProjectPageInput = {
    sourceId: record?.sourceId ?? null,
    url: snapshot.url,
    title: snapshot.title.length > 0 ? snapshot.title : null,
    page: {
      analysis: view,
      anchors: stored?.anchors ?? new Map(page.records.map((entry, at) => [entry.key, at + 1])),
      article,
      delivered: 'full',
    },
  };
  const projection = await projectPage(
    input,
    'full',
    fullViewBudget(services.budgets.maxBytesPerResult),
    services,
    new Set([PART_OF[resolved.kind]]),
  );
  if (record !== null) recordDiscovered(services, record.sourceId, projection.model);
  if (page.shape !== null) services.runHealth.recordPage(page.shape, projection.stats);

  // Every kind but links is evidence: the page was read for its content.
  if (record !== null && resolved.kind !== 'links') {
    services.evidence.add({
      url: snapshot.url,
      finalUrl: null,
      title: snapshot.title.length > 0 ? snapshot.title : null,
      excerpt: evidenceExcerpt(page, extraction.article?.excerpt ?? null),
      fetchedAt: services.nowIso(),
      publishedAt: extraction.article?.publishedAt ?? null,
      tool: 'browser_extract',
      sourceId: record.sourceId,
    });
  }
  return {
    ok: true,
    model: projection.model,
    details: {
      kind: resolved.kind,
      shape: page.shape,
      ...(record === null ? {} : { source_id: record.sourceId }),
      ...(projection.analysisCaptureRef === null
        ? {}
        : { analysis_capture_ref: projection.analysisCaptureRef }),
    },
  };
}

/**
 * The read a promoted workflow can replay for this request. Replay reads
 * readable content or the first table, so only `table` at index 0 promotes
 * as a table; every other kind promotes as the page's readable content (which
 * holds its text, cards, and tables), never as the wrong table.
 */
function replayableKind(resolved: PartRequest): 'content' | 'table' {
  return resolved.kind === 'table' && resolved.index === 0 ? 'table' : 'content';
}

/** The view part each kind returns. */
const PART_OF: Readonly<
  Record<Exclude<ExtractionKind, 'content'>, 'records' | 'links' | 'structured' | 'tables'>
> = {
  records: 'records',
  links: 'links',
  structured: 'structured',
  tables: 'tables',
  table: 'tables',
};

/**
 * The analysis a kind projects. `links` carries record links too, kind
 * `record`, because no records accompany it; `table` carries the one table.
 */
function viewFor(resolved: PartRequest, page: PageAnalysis): PageAnalysis {
  if (resolved.kind === 'table') {
    const table = page.tables[resolved.index];
    return { ...page, tables: table === undefined ? [] : [table] };
  }
  if (resolved.kind !== 'links') return page;
  const recordLinks: PageLink[] = page.records
    .filter((entry): entry is typeof entry & { url: string } => entry.url !== null)
    .map((entry) => ({ text: entry.title ?? '', url: entry.url, kind: 'record', sameSite: true }));
  const leading = page.links.filter((link) => link.kind === 'pagination' || link.kind === 'facet');
  const trailing = page.links.filter((link) => link.kind !== 'pagination' && link.kind !== 'facet');
  return { ...page, links: [...leading, ...recordLinks, ...trailing].slice(0, MAX_EXTRACT_LINKS) };
}

/** Links a `links` read returns, record links included (the page-link bound). */
const MAX_EXTRACT_LINKS = 40;

/** Characters of page text offered as the ledger excerpt (it bounds it further). */
const EVIDENCE_EXCERPT_CHARS = 1_000;

/**
 * Record a `content` read as ledger evidence, so `result_publish` attaches it
 * as a Brief source, and return its run-wide evidence ID (FEAT-050).
 *
 * A browser-driven run reads its answer off pages it clicked through to; before
 * this, only `web_search`/`web_fetch` fed the ledger, so such a run published
 * the search hop (or nothing) as its sources while every fact came from the
 * extracted page.
 *
 * Best-effort by design — an unusable URL (no navigation yet, a `data:`/blank
 * page) is skipped rather than turned into a junk source, and never fails the
 * extraction the agent asked for. The ID comes from the run document store's
 * `observe`, which never fetches: the page is already on screen. A page
 * `web_fetch` or `web_search` read keeps the ID they minted. The result is
 * never `already_read`: the live page may have changed since it was read.
 *
 * @returns The page's evidence ID, or null when none applies.
 */
function recordContentEvidence(
  extracted: { readonly title: string; readonly text: string },
  url: string,
  services: RunServices,
): string | null {
  if (!/^https?:\/\//iu.test(url)) return null;
  const { title, text } = extracted;
  const record = services.documents.observe(url, {
    title: title.length > 0 ? title : null,
    tool: 'browser_extract',
  });
  services.evidence.add({
    url,
    finalUrl: null,
    title: title.length > 0 ? title : null,
    excerpt: text.slice(0, EVIDENCE_EXCERPT_CHARS),
    fetchedAt: services.nowIso(),
    publishedAt: null,
    tool: 'browser_extract',
    sourceId: record.sourceId,
  });
  return record.sourceId;
}

function validSnapshot(value: unknown): value is PageSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['title', 'url', 'html', 'visibleText'].every((key) => typeof record[key] === 'string');
}
