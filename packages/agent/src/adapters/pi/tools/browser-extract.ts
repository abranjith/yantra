import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateUlid } from '@yantra/protocol';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { browserController, browserFailure, isDomainFailure } from './browser-common.js';

const BrowserExtractParams = Type.Object(
  {
    kind: Type.Union([Type.Literal('content'), Type.Literal('table')], {
      description: 'Typed extraction kind for the current page.',
    }),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserExtractParams>;

/** Build the typed current-page extraction tool. */
export function browserExtractSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserExtractParams> {
  return {
    name: 'browser_extract',
    label: 'Browser Extract',
    description:
      'Extract readable content or the first table from the current page with a validated result shape. Use it after navigation/observation. Do NOT use it to request arbitrary selectors or unsanitized page source.',
    parameters: BrowserExtractParams,
    sanitizationProfile: 'public',
    run: (params: Params, ctx): Promise<DomainResult> => runExtract(params, ctx.services),
  };
}

async function runExtract(params: Params, services: RunServices): Promise<DomainResult> {
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
    extracted = await controller.extract(params.kind);
  } catch (error) {
    return browserFailure(error);
  }
  if (!validExtraction(params.kind, extracted))
    return {
      ok: false,
      errorCode: 'EXTRACTION_SCHEMA_INVALID',
      message: `The page did not produce a valid ${params.kind} extraction.`,
      retryable: true,
    };
  services.trace?.append({
    kind: 'extract',
    host,
    extractionKind: params.kind,
    requires_confirmation: false,
  });
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
    model: { capture_ref: captureRef, preview: previewExtraction(params.kind, extracted) },
    details: { capture_ref: captureRef },
  };
}

function validExtraction(kind: Params['kind'], value: unknown): boolean {
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

function previewExtraction(kind: Params['kind'], value: unknown): unknown {
  const record = value as { title?: string; text?: string; headers?: unknown[]; rows?: unknown[] };
  return kind === 'content'
    ? { title: record.title, text: record.text?.slice(0, 1_000) }
    : { headers: record.headers, rows: record.rows?.slice(0, 5) };
}
