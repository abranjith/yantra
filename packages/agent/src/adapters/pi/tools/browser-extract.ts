import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentBrowserController } from '@yantra/core';
import { generateUlid } from '@yantra/protocol';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { browserController, browserFailure, isDomainFailure } from './browser-common.js';

/** The two extractions the controller supports. */
type ExtractionKind = 'content' | 'table';

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
  table: 'table',
  tables: 'table',
  first_table: 'table',
};

const BrowserExtractParams = Type.Object(
  {
    kind: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'What to extract: "content" for the page title plus readable text (the default), ' +
          'or "table" for the first table as headers/rows. Omit it to get "content".',
      }),
    ),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserExtractParams>;

/** Resolve a model-supplied kind to a canonical one; null when unsupported. */
function resolveKind(raw: string | undefined): ExtractionKind | null {
  if (raw === undefined) return 'content';
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return EXTRACTION_KINDS[normalized] ?? null;
}

/** Build the typed current-page extraction tool. */
export function browserExtractSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserExtractParams> {
  return {
    name: 'browser_extract',
    label: 'Browser Extract',
    description:
      'Extract readable content or the first table from the current page with a validated result shape. Call it after navigation/observation with kind:"content" (page title + readable text, also the default when kind is omitted) or kind:"table" (first table as headers/rows). Do NOT pass any other kind, arbitrary selectors, or ask for unsanitized page source.',
    parameters: BrowserExtractParams,
    sanitizationProfile: 'public',
    run: (params: Params, ctx): Promise<DomainResult> => runExtract(params, ctx.services),
  };
}

async function runExtract(params: Params, services: RunServices): Promise<DomainResult> {
  // Input first: an unsupported kind is the model's mistake to correct, and it
  // must be reported the same way whether or not a browser is configured.
  const kind = resolveKind(params.kind);
  if (kind === null)
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message:
        `"${params.kind?.slice(0, 40) ?? ''}" is not a supported extraction kind. ` +
        'Retry with kind:"content" for the page title and readable text, or kind:"table" ' +
        'for the first table.',
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
          message: 'Browser services are not configured.',
          retryable: false,
        };
  const host = controller.host();
  let extracted: unknown;
  try {
    extracted = await controller.extract(kind);
  } catch (error) {
    return browserFailure(error);
  }
  if (!validExtraction(kind, extracted))
    return {
      ok: false,
      errorCode: 'EXTRACTION_SCHEMA_INVALID',
      message: `The page did not produce a valid ${kind} extraction.`,
      retryable: true,
    };
  services.trace?.append({
    kind: 'extract',
    host,
    extractionKind: kind,
    requires_confirmation: false,
  });
  recordEvidence(kind, extracted, controller, services);
  const serialized = JSON.stringify(extracted);
  if (Buffer.byteLength(serialized, 'utf8') <= deps.captureThresholdBytes)
    return { ok: true, model: extracted };
  const captureRef = `cap-${generateUlid()}`;
  const captureDir = join(services.runDir, 'captures');
  await mkdir(captureDir, { recursive: true });
  await writeFile(join(captureDir, `${captureRef}.json`), serialized, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return {
    ok: true,
    model: { capture_ref: captureRef, preview: previewExtraction(kind, extracted) },
    details: { capture_ref: captureRef },
  };
}

/** Bytes of extracted page text offered as the ledger excerpt (it bounds it further). */
const EVIDENCE_EXCERPT_CHARS = 1_000;

/**
 * Record a read page as ledger evidence, so `result_publish` attaches it as a
 * Brief source.
 *
 * A browser-driven run reads its answer off pages it clicked through to; before
 * this, only `web_search`/`web_fetch` fed the ledger, so such a run published
 * the search hop (or nothing) as its sources while every fact came from the
 * extracted page. Only `content` extractions qualify: a `table` extraction
 * carries no page title or prose to excerpt, and the page it came from is
 * recorded when the agent reads its content.
 *
 * Best-effort by design — an unusable URL (no navigation yet, a `data:`/blank
 * page) is skipped rather than turned into a junk source, and never fails the
 * extraction the agent asked for.
 */
function recordEvidence(
  kind: ExtractionKind,
  extracted: unknown,
  controller: AgentBrowserController,
  services: RunServices,
): void {
  if (kind !== 'content') return;
  const url = controller.url();
  if (!/^https?:\/\//iu.test(url)) return;
  const { title, text } = extracted as { title: string; text: string };
  services.evidence.add({
    url,
    finalUrl: null,
    title: title.length > 0 ? title : null,
    excerpt: text.slice(0, EVIDENCE_EXCERPT_CHARS),
    fetchedAt: services.nowIso(),
    publishedAt: null,
    tool: 'browser_extract',
  });
}

function validExtraction(kind: ExtractionKind, value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (kind === 'content')
    return typeof record.title === 'string' && typeof record.text === 'string';
  return (
    Array.isArray(record.headers) &&
    record.headers.every((cell) => typeof cell === 'string') &&
    Array.isArray(record.rows) &&
    record.rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'))
  );
}

function previewExtraction(kind: ExtractionKind, value: unknown): unknown {
  const record = value as { title?: string; text?: string; headers?: unknown[]; rows?: unknown[] };
  return kind === 'content'
    ? { title: record.title, text: record.text?.slice(0, 1_000) }
    : { headers: record.headers, rows: record.rows?.slice(0, 5) };
}
