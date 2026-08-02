/**
 * Briefs and templated reports deliberately share this terminal tool: the
 * orchestration latch, correction loop, audit trail, and success rule remain
 * identical. An active manifest replaces the static Brief parameters with
 * generated slot parameters, and Yantra renders the `document.*` artifacts.
 *
 * `result_publish` tool spec (FEAT-024 TASK-007, plan_agentic.md §5/§8.9/§13).
 *
 * The terminal completion contract: raw prose is not success. The agent must
 * publish a validated Brief. The agent supplies *prose* — title, overview, and
 * optional findings — and Yantra builds the formal protocol Brief around it
 * (ids, numbering, hosts, timestamps, metadata), validates it, persists
 * `brief.json/md/html` on success, and closes the run's action phase so later
 * mutating tools are rejected. Exactly one *successful* publication is allowed;
 * a second attempt returns `ALREADY_PUBLISHED`, and a validation failure returns
 * a structured, correctable error listing the offending references.
 *
 * Sources are **ledger-authoritative**: when the run's evidence ledger has
 * entries (every site `web_search`/`web_fetch` returned), those entries become
 * the Brief's sources — with excerpts — and any model-supplied `sources` are
 * ignored. Small local models cannot reliably round-trip URLs from earlier tool
 * results into a typed payload (observed: placeholder `"N/A"` sources, and a
 * completion-nudged re-search that changed the answer); the runtime already
 * owns that data, so the model is never asked to courier it. Model-supplied
 * sources are honored only when the ledger is empty (for example browser-only
 * `do` runs).
 */

import { renderTemplate, writeBriefArtifacts, writeReportArtifacts } from '@yantra/core';
import {
  BRIEF_SCHEMA_VERSION,
  TemplatedReportValidationError,
  createBrief,
  generateUlid,
  validateBrief,
  validateTemplatedReport,
  type Brief,
  type BriefSource,
  type BriefValidationError,
  type KeyFinding,
  type Result,
  type TemplateManifest,
  type TemplateSlotValue,
  type TemplatedReport,
} from '@yantra/protocol';
import { Type, type Static, type TObject } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type {
  EvidenceEntry,
  PublishOutcome,
  PublishToolDeps,
  PublishValidationError,
  RunServices,
} from '../../../runtime/run-services.js';

import { templateParamsFor } from './template-params.js';
import { validateSlots } from './template-validate.js';

/**
 * The agent-authored content shape. `title`/`overview` are structurally
 * required so the provider surfaces a named missing field *before* the call
 * runs — small local models repeatedly omitted `title` when the whole payload
 * was `Type.Unknown` and the post-hoc BRIEF_INVALID message read like a length
 * problem ("String must contain at least 1 character(s)"), not a missing one.
 * The object stays open (`additionalProperties: true`) because complete
 * protocol Briefs (internal/scripted callers) travel through the same
 * parameter; content-level validation remains the publisher's job.
 */
const BriefContentParams = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      description: 'One-line title of the result. Required.',
    }),
    overview: Type.String({
      description: 'Answer-first Markdown overview (1-3 paragraphs). Required.',
    }),
    key_findings: Type.Optional(
      Type.Array(Type.Unknown(), {
        description: 'Optional scannable findings, each a short plain-text string.',
      }),
    ),
    sources: Type.Optional(
      Type.Array(Type.Unknown(), {
        description:
          'Usually omit this: the pages you consulted via web_search/web_fetch are attached ' +
          'as sources automatically. Provide urls only for evidence gathered outside those tools.',
      }),
    ),
  },
  {
    additionalProperties: true,
    description:
      'The final result content. Yantra builds and validates the formal Brief document ' +
      '(ids, numbering, hosts, timestamps, metadata, sources) from this content.',
  },
);

const ResultPublishParams = Type.Object(
  { brief: BriefContentParams },
  { additionalProperties: false },
);

/**
 * Build the `result_publish` tool spec for one run.
 *
 * @param services Per-run services carrying the optional active template.
 * @returns The provider-neutral tool spec consumed by `wrapTool`.
 */
export function resultPublishSpec(services: RunServices): ToolWrapperSpec<TObject> {
  const parameters =
    services.template === null ? ResultPublishParams : templateParamsFor(services.template);
  return {
    name: 'result_publish',
    label: 'Publish Result',
    description:
      services.template === null
        ? 'Publish the final answer as a validated Brief. This is the ONLY way to complete a task — ' +
          'raw chat text is not a completed result. Call it once, when your answer is ready, with ' +
          '{"brief": {"title": ..., "overview": ...}}; the web pages you consulted are attached as ' +
          'sources automatically, so you never need to list URLs. Do NOT call it before gathering ' +
          'the evidence you need, and do NOT invent facts or URLs; invalid Briefs are rejected with ' +
          'the specific problems to fix.'
        : `Publish the final values for template "${services.template.name ?? 'unnamed'}". ` +
          `Fill the report slots (${services.template.slots
            .filter((slot) => slot.kind !== 'sources')
            .map((slot) => slot.key)
            .join(', ')}); Yantra renders the surrounding document and attaches consulted ` +
          'sources automatically. Do not supply layout Markdown or URLs. Invalid values are ' +
          'returned with exact issues to fix.',
    parameters,
    sanitizationProfile: 'public',
    // The run's only exit. Exempt from the run-wide cumulative budgets so a run
    // that spent its exploration budget can still publish what it gathered
    // instead of discarding the whole run (its per-tool cap still bounds the
    // correction-retry loop).
    terminal: true,
    run: (params: Static<TObject>, ctx): Promise<DomainResult> => runPublish(params, ctx.services),
  };
}

async function runPublish(params: unknown, services: RunServices): Promise<DomainResult> {
  // The action phase closing is the single-successful-publication latch.
  if (services.actionPhase.isClosed()) {
    return {
      ok: false,
      errorCode: 'ALREADY_PUBLISHED',
      message: 'A result has already been published for this run.',
      retryable: false,
    };
  }

  const paramsRecord = asRecord(params) ?? {};
  if (services.template !== null) {
    const result = await services.domain.publish.publish(paramsRecord.report);
    if (!result.isOk) {
      return {
        ok: false,
        errorCode: 'REPORT_INVALID',
        message: result.error.message,
        retryable: true,
        details: { issues: result.error.issues },
      };
    }
    services.actionPhase.close();
    const report = result.value.brief as TemplatedReport;
    return {
      ok: true,
      model: { published: true, summary: result.value.summary, html_path: result.value.htmlPath },
      details: { report_id: report.report_id },
      terminate: true,
    };
  }

  // Ledger-authoritative composition applies to agent-authored content only:
  // a complete protocol Brief (internal/scripted callers) owns its sources and
  // typed findings, so it passes through untouched.
  const briefInput = paramsRecord.brief;
  const evidence = services.evidence.entries();
  const content =
    evidence.length > 0 && !isCompleteBrief(briefInput)
      ? withLedgerEvidence(briefInput, evidence)
      : briefInput;
  const result = await services.domain.publish.publish(content);
  if (!result.isOk) {
    // A URL validation miss gets an explicit remedy: small local models have
    // been observed publishing placeholder sources ("N/A") instead of copying
    // the url values their web tool results already contain.
    const urlHint = /\burl\b/i.test(result.error.message)
      ? ' Source urls must be the exact absolute https URLs from your web_search/web_fetch results — copy them verbatim, never a placeholder.'
      : '';
    return {
      ok: false,
      errorCode: 'BRIEF_INVALID',
      message: `${result.error.message}${urlHint}`,
      retryable: true,
      details: { issues: result.error.issues },
    };
  }

  services.actionPhase.close();
  return {
    ok: true,
    model: { published: true, summary: result.value.summary, html_path: result.value.htmlPath },
    details: { brief_id: (result.value.brief as Brief).brief_id },
    terminate: true,
  };
}

/**
 * Ledger-authoritative composition: the runtime already knows every source the
 * run consulted, so the model's payload is reduced to prose. Model-supplied
 * `sources` are replaced wholesale by the ledger, and findings are coerced to
 * uncited editorial text — the model's ad-hoc citation numbers (per-call
 * `web_search` numbering) cannot be trusted against run-wide ledger numbering,
 * and the Brief's evidence lives in the attached sources + excerpts instead.
 */
function withLedgerEvidence(
  brief: unknown,
  evidence: readonly EvidenceEntry[],
): Record<string, unknown> {
  const record = asRecord(brief) ?? {};
  return {
    ...record,
    key_findings: asArray(record.key_findings)
      .map(findingText)
      .filter((text) => text.length > 0),
    sources: evidenceToSourceRecords(evidence),
  };
}

/** Extract the plain text of a model-supplied finding (string or {text}). */
function findingText(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  const text = asRecord(entry)?.text;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Project ledger entries onto agent-content source records, in consulted
 * order. Field values are normalized defensively (extraction-derived dates and
 * redirect URLs can be junk) so a runtime-attached source can never be the
 * reason a Brief fails validation.
 */
export function evidenceToSourceRecords(
  evidence: readonly EvidenceEntry[],
): Record<string, unknown>[] {
  return evidence.map((entry) => ({
    url: entry.url,
    final_url: parseableUrl(entry.finalUrl),
    title: entry.title,
    excerpt: entry.excerpt,
    fetched_at: isoDatetimeOrNull(entry.fetchedAt) ?? undefined,
    published_at: isoDatetimeOrNull(entry.publishedAt),
  }));
}

/** Canonical ISO-8601 UTC form of any parseable timestamp, else null. */
function isoDatetimeOrNull(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** The URL itself when parseable, else null. */
function parseableUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}

/** Run-identity context stamped into Briefs built from agent content. */
export interface BriefPublisherContext {
  /** Owning task ULID; a fresh ULID is generated when omitted. */
  readonly taskId?: string;
  /** Owning run id recorded in Brief metadata. */
  readonly runId?: string;
  /** Clock override for source `fetched_at` stamps (tests). */
  readonly now?: () => Date;
}

/**
 * Default Brief publisher. Accepts either a complete protocol Brief (internal
 * and scripted callers) or agent-authored content — `{title, overview,
 * key_findings, sources}` — which is deterministically assembled into a
 * protocol Brief (ids, contiguous source numbering, hosts, timestamps,
 * metadata). Either shape is then validated against the protocol Brief schema
 * (citation integrity included) and persisted as `brief.json/md/html`.
 * Models cannot author `brief_id`/`task_id` ULIDs or metadata, so validating
 * their payload directly would make publication structurally impossible.
 *
 * @param runDir The owning run directory.
 * @param context Optional run identity stamped into agent-built Briefs.
 * @returns A {@link PublishToolDeps} for wiring into RunServices.
 */
export function createBriefPublisher(
  runDir: string,
  context: BriefPublisherContext = {},
): PublishToolDeps {
  return {
    publish: async (
      raw: unknown,
      options?: { readonly assembledByRuntime?: boolean },
    ): Promise<Result<PublishOutcome, BriefValidationError>> => {
      const assembled = options?.assembledByRuntime === true;
      const candidate = isCompleteBrief(raw)
        ? raw
        : buildBriefFromAgentContent(raw, context, assembled);
      const validated = validateBrief(candidate);
      if (!validated.isOk) {
        return validated;
      }
      const brief: Brief = validated.value;
      const written = await writeBriefArtifacts(runDir, brief);
      if (!written.isOk) {
        // A persistence failure is not a Brief-validity failure; surface it as a
        // schema-shaped error so the single publish contract still holds.
        return {
          isOk: false,
          error: {
            name: 'BriefValidationError',
            code: 'brief_validation_error',
            message: `Brief validated but could not be persisted: ${written.error.message}`,
            issues: [],
          } as unknown as BriefValidationError,
        };
      }
      return {
        isOk: true,
        value: {
          brief,
          htmlPath: written.value.htmlPath,
          summary: briefSummary(brief),
        },
      };
    },
  };
}

/** Run identity and template provenance stamped into a templated report. */
export interface TemplatedReportPublisherContext {
  /** Owning task ULID; generated when omitted. */
  readonly taskId?: string;
  /** Owning run id recorded in reused Brief metadata. */
  readonly runId?: string;
  /** Whether the active reference came from the saved library or a file path. */
  readonly source?: 'saved' | 'path';
  /** Absolute source path for path references, otherwise null. */
  readonly path?: string | null;
  /** Resolved display name when frontmatter omitted one. */
  readonly name?: string | null;
  /** Lazy evidence-ledger view evaluated at publication time. */
  readonly evidence?: () => readonly EvidenceEntry[];
  /** Clock override for source defaults and tests. */
  readonly now?: () => Date;
}

/**
 * Create the publisher used by a generated report-template schema.
 *
 * The model supplies slot values only. Sources are rebuilt from the run ledger,
 * values pass content validation, the runtime renders the manifest, the final
 * protocol document is validated, and `document.json/md/html` are persisted.
 *
 * @param runDir Owning run directory.
 * @param manifest Active parsed template.
 * @param context Run identity, template reference, and lazy evidence view.
 * @returns A publication dependency compatible with the existing tool loop.
 */
export function createTemplatedReportPublisher(
  runDir: string,
  manifest: TemplateManifest,
  context: TemplatedReportPublisherContext = {},
): PublishToolDeps {
  return {
    publish: async (raw: unknown): Promise<Result<PublishOutcome, PublishValidationError>> => {
      const valuesRecord = asRecord(raw) ?? {};
      // The generated provider schema excludes sources; direct/internal callers
      // get the same invariant by having any supplied value ignored here.
      const values = Object.fromEntries(
        Object.entries(valuesRecord).filter(([key]) => key !== 'sources'),
      );
      const nowIso = (context.now?.() ?? new Date()).toISOString();
      const sourceRecords = evidenceToSourceRecords(context.evidence?.() ?? []);
      const sources = sourceRecords.map((entry, index) => toSource(entry, index, nowIso));
      const slotIssues = validateSlots(manifest, values, sources);
      if (slotIssues.length > 0) {
        return { isOk: false, error: new TemplatedReportValidationError(slotIssues) };
      }

      const slotValues = values as Record<string, TemplateSlotValue>;
      const titleValue = slotValues.title;
      const title =
        typeof titleValue === 'string' && titleValue.trim().length > 0
          ? titleValue.trim()
          : titleFromName(context.name ?? manifest.name);
      const report: TemplatedReport = {
        report_id: generateUlid(),
        task_id: context.taskId ?? generateUlid(),
        schema_version: BRIEF_SCHEMA_VERSION,
        template: {
          name: context.name ?? manifest.name,
          source: context.source ?? 'saved',
          path: context.path ?? null,
          hash: manifest.hash,
        },
        title,
        slots: slotValues,
        rendered_md: renderTemplate(manifest, slotValues, sources),
        sources,
        metadata: {
          search_provider: null,
          synthesis: 'llm',
          deterministic_fallback_used: false,
          coverage: null,
          freshness: null,
          citation_verdict: null,
          usage: null,
          evidence: null,
          run_id: context.runId ?? null,
        },
        notices: [],
      };
      const validated = validateTemplatedReport(report);
      if (!validated.isOk) return validated;
      const written = await writeReportArtifacts(runDir, validated.value);
      if (!written.isOk) {
        return {
          isOk: false,
          error: new TemplatedReportValidationError([
            { path: [], pointer: '', message: written.error.message },
          ]),
        };
      }
      return {
        isOk: true,
        value: {
          brief: validated.value,
          htmlPath: written.value.htmlPath,
          summary: `Published "${validated.value.title}" with ${sources.length} source(s).`,
        },
      };
    },
  };
}

function titleFromName(name: string | null): string {
  if (name === null || name.length === 0) return 'Templated report';
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

/** One-line human summary for the model-visible publish result. */
function briefSummary(brief: Brief): string {
  const firstLine = brief.overview.split('\n').find((line) => line.trim().length > 0) ?? '';
  return `Published "${brief.title}" with ${brief.sources.length} source(s). ${firstLine}`.trim();
}

/** A payload carrying protocol identity fields is treated as a complete Brief. */
function isCompleteBrief(raw: unknown): boolean {
  const record = asRecord(raw);
  return record !== undefined && ('brief_id' in record || 'schema_version' in record);
}

/**
 * Assemble a protocol Brief from agent-authored content. Mapping is lenient —
 * junk values flow into the built document and `validateBrief` reports them
 * with pointers that match the agent's input shape (`title`, `sources/0/url`,
 * `key_findings/0/citations/0`, ...), which is the structured retry loop.
 * `assembledByRuntime` marks the deterministic fallback path (the orchestrator
 * packaging the agent's draft) honestly in metadata and notices.
 */
function buildBriefFromAgentContent(
  raw: unknown,
  context: BriefPublisherContext,
  assembledByRuntime = false,
): unknown {
  const record = asRecord(raw) ?? {};
  const nowIso = (context.now?.() ?? new Date()).toISOString();
  return createBrief({
    task_id: context.taskId ?? generateUlid(),
    title: typeof record.title === 'string' ? record.title : '',
    overview: typeof record.overview === 'string' ? record.overview : '',
    key_findings: asArray(record.key_findings).map(toKeyFinding),
    sources: asArray(record.sources).map((entry, index) => toSource(entry, index, nowIso)),
    metadata: {
      synthesis: 'llm',
      run_id: context.runId ?? null,
      ...(assembledByRuntime ? { deterministic_fallback_used: true } : {}),
    },
    notices: assembledByRuntime
      ? [
          {
            source: 'runtime',
            reason:
              'The agent did not publish; the runtime assembled this Brief from the ' +
              "agent's final draft and the sources fetched during the run.",
            kind: 'other',
          },
        ]
      : [],
  });
}

function toKeyFinding(entry: unknown): KeyFinding {
  if (typeof entry === 'string') {
    // A bare string carries no citations; publish it as explicit commentary
    // rather than rejecting the whole Brief for a missing citations array.
    return { text: entry, citations: [], editorial: true, facet: null, children: [] };
  }
  const record = asRecord(entry) ?? {};
  // Junk citation values flow through so validateBrief reports them at the
  // agent-visible pointer instead of being silently dropped here.
  const citations = [...asArray(record.citations)] as number[];
  return {
    text: typeof record.text === 'string' ? record.text : '',
    citations,
    // An explicit editorial flag is honored (editorial: false with no
    // citations stays false so validation rejects the uncited claim);
    // otherwise uncited findings default to commentary.
    editorial: typeof record.editorial === 'boolean' ? record.editorial : citations.length === 0,
    facet: null,
    children: [],
  };
}

function toSource(entry: unknown, index: number, fetchedAt: string): BriefSource {
  const record = asRecord(entry) ?? {};
  const url = typeof entry === 'string' ? entry : typeof record.url === 'string' ? record.url : '';
  // Provenance fields pass through when supplied (the evidence-ledger records
  // carry real fetch/publication data); model string/`{url,title}` sources
  // keep the historical defaults.
  return {
    n: index + 1,
    url,
    final_url: typeof record.final_url === 'string' ? record.final_url : null,
    host: hostOf(url),
    title: typeof record.title === 'string' ? record.title : null,
    excerpt: typeof record.excerpt === 'string' ? record.excerpt : null,
    fetched_at: typeof record.fetched_at === 'string' ? record.fetched_at : fetchedAt,
    published_at: typeof record.published_at === 'string' ? record.published_at : null,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'unknown';
  } catch {
    // An unparsable URL fails schema validation at sources[n].url with an
    // actionable pointer; a placeholder host avoids a second, noisier issue.
    return 'unknown';
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
