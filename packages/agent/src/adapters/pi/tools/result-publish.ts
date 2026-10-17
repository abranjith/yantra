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
 * entries (every site `web_search`/`web_fetch` returned, plus every page
 * `browser_extract` read), those entries become the Brief's sources — with
 * excerpts — and any model-supplied `sources` are ignored. Small local models
 * cannot reliably round-trip URLs from earlier tool results into a typed
 * payload (observed: placeholder `"N/A"` sources, and a completion-nudged
 * re-search that changed the answer); the runtime already owns that data, so
 * the model is never asked to courier it. Model-supplied sources are honored
 * only when the ledger is empty (a run that published without reading a page).
 */

import {
  renderTemplate,
  writeBriefArtifacts,
  writeReportArtifacts,
  type FillCensus,
  type FillCensusSource,
} from '@yantra/core';
import {
  BRIEF_SCHEMA_VERSION,
  TemplatedReportValidationError,
  createBrief,
  generateUlid,
  validateBrief,
  validateTemplatedReport,
  type Brief,
  type BriefFacets,
  type BriefConstraint,
  type BriefRequirement,
  type Section,
  type BriefNotice,
  type BriefSource,
  type BriefValidationError,
  type KeyFinding,
  type Result,
  type TemplateManifest,
  type TemplateSlotValue,
  type TemplatedReport,
} from '@yantra/protocol';
import { Type, type Static, type TObject } from 'typebox';

import {
  composeAgentBrief,
  composedPublishSummary,
  logBriefComposition,
  mapPublishText,
  sanitizePublishContent,
  type ComposedEvidence,
} from '../../../runtime/brief-composer.js';
import { visionContractCapabilities } from '../../../runtime/contract-capabilities.js';
import {
  censusFillEvaluator,
  evaluateFulfillment,
  fulfillmentSummary,
  toBriefRequirements,
  type FulfillmentEvaluation,
} from '../../../runtime/fulfillment.js';
import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type {
  EvidenceEntry,
  PublishOptions,
  PublishOutcome,
  PublishRuntimeFacts,
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
 * The object stays open (`additionalProperties: true`) for legacy content
 * fields. Every model payload passes through composition; trusted callers
 * supply complete protocol Briefs directly to the publisher API.
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
        maxItems: 20,
        description: 'A plain string (uncited commentary) or {text, sources: ["S3", "S3#r5"]}.',
      }),
    ),
    sections: Type.Optional(
      Type.Array(
        Type.Object({
          heading: Type.String({ minLength: 1, maxLength: 120 }),
          body_md: Type.String({ maxLength: 4000 }),
          sources: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
        }),
        { maxItems: 8 },
      ),
    ),
    constraints: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: 60 }),
          value: Type.String({ minLength: 1, maxLength: 120 }),
          status: Type.String({ enum: ['verified', 'unverified', 'violated'] }),
          sources: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
        }),
        { maxItems: 12 },
      ),
    ),
    fulfillment: Type.Optional(
      Type.Object({
        met: Type.Boolean(),
        unmet: Type.Array(
          Type.Object({
            item: Type.String({ minLength: 1, maxLength: 80 }),
            reason: Type.String({ minLength: 1, maxLength: 200 }),
          }),
          { maxItems: 12 },
        ),
      }),
    ),
    table: Type.Optional(
      Type.Object({
        columns: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
          minItems: 1,
          maxItems: 12,
        }),
        rows: Type.Array(
          Type.Array(Type.Unknown({ description: 'string, number, boolean, or null' })),
          { minItems: 1, maxItems: 50 },
        ),
        row_sources: Type.Array(Type.Array(Type.String(), { maxItems: 8 }), { maxItems: 50 }),
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
          'sources automatically. Cite evidence by source_id or record id (S3, S3#r5): findings ' +
          'as {text, sources: ["S3"]}, prose as [S3]. Publish items with fields as a table ' +
          '{columns, rows, row_sources}, one citation list per row. Report conditions in ' +
          'constraints with status verified, unverified, or violated; list undelivered items ' +
          'and reasons in fulfillment.unmet. Invalid references return the exact fix. Do NOT call it before gathering ' +
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

  // FEAT-054 D4: a `do` result is judged against its contract, so publishing
  // without one is refused on both the Brief and the template path. The
  // remedy names the one engineered move: declare it, then publish again.
  if (services.contract.requiredToPublish && services.contract.current() === null) {
    return {
      ok: false,
      errorCode: 'CONTRACT_REQUIRED',
      message: renderAgentMessage('tool', 'CONTRACT_REQUIRED', 'missing'),
      retryable: true,
      diagnostic: { cause: 'missing' },
    };
  }

  const paramsRecord = asRecord(params) ?? {};
  // The run's own facts (search failures, budget exhaustion, read failures,
  // provider), computed once at publish time and attached by the publisher.
  const runtimeFacts = runtimeFactsFor(services);
  if (services.template !== null) {
    const evaluation = await evaluatePublication(services, null);
    const result = await services.domain.publish.publish(paramsRecord.report, { runtimeFacts });
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
    services.runHealth.recordPublishedNotices(runtimeFacts.notices.length);
    recordEvaluation(services, evaluation);
    const report = result.value.brief as TemplatedReport;
    return {
      ok: true,
      model: {
        published: true,
        summary: result.value.summary,
        html_path: result.value.htmlPath,
        ...(evaluation === null ? {} : { requirements: fulfillmentSummary(evaluation) }),
      },
      details: { report_id: report.report_id },
      terminate: true,
    };
  }

  // Tool arguments are always model-authored. Complete protocol Briefs belong
  // to the trusted publisher API, never a branch selected by argument fields.
  const briefInput = paramsRecord.brief;
  const evidence = services.evidence.entries();
  const composed = composeAgentBrief(
    sanitizePublishContent(
      briefInput,
      services.sanitizer,
      (text) => services.userInput?.mask(text) ?? text,
    ),
    {
      evidence,
      documents: services.documents,
      contract: services.contract.current(),
      mode: 'tool',
    },
  );
  if (!composed.isOk) {
    const issues = composed.error.map((issue) => ({
      cause: issue.cause,
      pointer: issue.pointer,
      message: renderAgentMessage('tool', 'BRIEF_INVALID', issue.cause, issue.values),
    }));
    return {
      ok: false,
      errorCode: 'BRIEF_INVALID',
      retryable: true,
      message: issues
        .slice(0, 5)
        .map((issue) => issue.message)
        .join(' '),
      details: { issues },
    };
  }
  const evaluation = await evaluatePublication(services, composed.value.evidence);
  const composedContent = withRequirements(composed.value.content, evaluation);
  const content =
    services.userInput === undefined
      ? composedContent
      : mapPublishText(composedContent, (text) => services.userInput!.resolve(text));
  const publishFacts = runtimeFactsFor(services, [
    ...composed.value.notices,
    ...(evaluation?.disagreement ? [evaluation.disagreement] : []),
  ]);
  const result = await services.domain.publish.publish(content, {
    runtimeFacts: publishFacts,
    citationVerdict: composed.value.verdict,
  });
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
  services.runHealth.recordPublishedNotices(publishFacts.notices.length);
  logBriefComposition(services, composed.value.summary);
  recordEvaluation(services, evaluation);
  const brief = result.value.brief as Brief;
  return {
    ok: true,
    model: {
      published: true,
      summary: composedPublishSummary(brief.title, brief.overview, composed.value.summary),
      html_path: result.value.htmlPath,
      ...(evaluation === null ? {} : { requirements: fulfillmentSummary(evaluation) }),
    },
    details: {
      brief_id: brief.brief_id,
      composition: composed.value.summary,
    },
    terminate: true,
  };
}

/**
 * Judges the publication against the run's contract (FEAT-054), for `do`
 * only: `ask` and `research` keep their criteria and their Briefs unchanged.
 *
 * @param evidence What the composition established, or null on the template
 *   path, which has no delivery check.
 * @returns The evaluation, or null for a command that is not judged per item.
 */
export async function evaluatePublication(
  services: Pick<
    RunServices,
    'contract' | 'actionLedger' | 'contractCapabilities' | 'vision' | 'fillCensus'
  >,
  evidence: ComposedEvidence | null,
): Promise<FulfillmentEvaluation | null> {
  if (services.contract.command !== 'do') return null;
  const capabilities = services.contractCapabilities ?? visionContractCapabilities(services.vision);
  const terms = services.contract.effectiveActionTerms();
  // The census is a page read, paid only when the contract declares a fill.
  const census =
    terms.fill === null || services.fillCensus === undefined
      ? null
      : await readCensus(services.fillCensus);
  return evaluateFulfillment({
    command: services.contract.command,
    contract: services.contract.current(),
    terms,
    deliverableGaps: evidence?.deliverableGaps ?? [],
    constraints: evidence?.constraints ?? [],
    ledger: services.actionLedger.entries(),
    claimedMet: evidence?.claimedMet ?? null,
    captureGap: (scope) => capabilities.captureGap(scope),
    evaluateFill: censusFillEvaluator(census),
  });
}

/** A census, or an incomplete one when the read fails: never an exception path. */
async function readCensus(source: FillCensusSource): Promise<FillCensus | null> {
  try {
    return await source.census();
  } catch {
    // swallow-ok: a failed census read is an honest "not counted", never a failed publish
    return { epoch: null, host: '', complete: false, controls: [] };
  }
}

/** Stores a successful publication's evaluation and logs its counts only. */
export function recordEvaluation(
  services: Pick<RunServices, 'fulfillment' | 'runtimeLogger'>,
  evaluation: FulfillmentEvaluation | null,
): void {
  if (evaluation === null) return;
  services.fulfillment.record(evaluation);
  const count = (status: string): number =>
    evaluation.items.filter((item) => item.status === status).length;
  services.runtimeLogger?.info(
    {
      schema_version: 1,
      event: 'fulfillment_evaluated',
      contract_declared: evaluation.contractDeclared,
      met: count('met'),
      unmet: count('unmet'),
      not_applicable: count('not_applicable'),
      disagreement: evaluation.disagreement !== null,
    },
    'fulfillment evaluated',
  );
}

/** Content with the evaluation's `requirements`, or unchanged when there is none to show. */
export function withRequirements(
  content: Record<string, unknown>,
  evaluation: FulfillmentEvaluation | null,
): Record<string, unknown> {
  if (evaluation === null || evaluation.items.length === 0) return content;
  return { ...content, requirements: toBriefRequirements(evaluation) };
}

/**
 * The run's own facts for one published document: the single assembly point
 * shared by the tool path and the runtime-assembled fallback. Whole-run
 * notices the run owns (a `research`/`do` run that never declared a task
 * contract) lead, ahead of the runtime-derived ones, before the notice cap.
 */
export function runtimeFactsFor(
  services: Pick<RunServices, 'runHealth' | 'contract'>,
  composedNotices?: readonly BriefNotice[],
): PublishRuntimeFacts {
  if (composedNotices === undefined)
    return services.runHealth.briefFacts(services.contract.notices());
  const facts = services.runHealth.briefFacts();
  return {
    ...facts,
    notices: [...services.contract.notices(), ...composedNotices, ...facts.notices],
  };
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
    // swallow-ok: URL parse helper; null means not parseable
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
      options?: PublishOptions,
    ): Promise<Result<PublishOutcome, BriefValidationError>> => {
      const assembled = options?.assembledByRuntime === true;
      const built = isCompleteBrief(raw)
        ? raw
        : buildBriefFromAgentContent(raw, context, assembled, options?.citationVerdict);
      const candidate = withRuntimeFacts(built, options?.runtimeFacts);
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
    publish: async (
      raw: unknown,
      options?: PublishOptions,
    ): Promise<Result<PublishOutcome, PublishValidationError>> => {
      const valuesRecord = asRecord(raw) ?? {};
      const facts = options?.runtimeFacts;
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
          search_provider: facts?.searchProvider ?? null,
          synthesis: 'llm',
          deterministic_fallback_used: false,
          coverage: null,
          freshness: null,
          citation_verdict: null,
          usage: null,
          evidence: null,
          run_id: context.runId ?? null,
        },
        notices: [...(facts?.notices ?? [])],
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

/**
 * Attach the run's own facts to a candidate Brief: runtime notices go after
 * any existing ones (the runtime-assembly notice stays first), and a known
 * search provider fills `metadata.search_provider`. Non-object candidates pass
 * through so validation reports them as before.
 */
function withRuntimeFacts(candidate: unknown, facts: PublishRuntimeFacts | undefined): unknown {
  if (facts === undefined) return candidate;
  const record = asRecord(candidate);
  if (record === undefined) return candidate;
  const existing = Array.isArray(record.notices) ? (record.notices as readonly BriefNotice[]) : [];
  const metadata = asRecord(record.metadata);
  return {
    ...record,
    notices: [...existing, ...facts.notices],
    ...(metadata !== undefined && facts.searchProvider !== null
      ? { metadata: { ...metadata, search_provider: facts.searchProvider } }
      : {}),
  };
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
  citationVerdict?: PublishOptions['citationVerdict'],
): unknown {
  const record = asRecord(raw) ?? {};
  const nowIso = (context.now?.() ?? new Date()).toISOString();
  return createBrief({
    task_id: context.taskId ?? generateUlid(),
    title: typeof record.title === 'string' ? record.title : '',
    overview: typeof record.overview === 'string' ? record.overview : '',
    key_findings: asArray(record.key_findings).map(toKeyFinding),
    sections: asArray(record.sections) as Section[],
    facets: (record.facets ?? null) as BriefFacets | null,
    ...(Array.isArray(record.constraints)
      ? { constraints: record.constraints as BriefConstraint[] }
      : {}),
    ...(Array.isArray(record.requirements)
      ? { requirements: record.requirements as BriefRequirement[] }
      : {}),
    sources: asArray(record.sources).map((entry, index) => toSource(entry, index, nowIso)),
    metadata: {
      synthesis: 'llm',
      run_id: context.runId ?? null,
      citation_verdict: citationVerdict ?? { claims_checked: 0, flagged: 0, stripped: 0 },
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
    ...(typeof record.cited === 'boolean' ? { cited: record.cited } : {}),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'unknown';
  } catch {
    // swallow-ok: URL parse helper; schema validation reports the bad URL
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
