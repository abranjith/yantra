/**
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

import { writeBriefArtifacts } from '@yantra/core';
import {
  createBrief,
  generateUlid,
  validateBrief,
  type Brief,
  type BriefSource,
  type BriefValidationError,
  type KeyFinding,
  type Result,
} from '@yantra/protocol';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type {
  EvidenceEntry,
  PublishOutcome,
  PublishToolDeps,
  RunServices,
} from '../../../runtime/run-services.js';

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

type ResultPublishParamsType = Static<typeof ResultPublishParams>;

/**
 * Build the `result_publish` tool spec for one run.
 *
 * @param _services Reserved for symmetry with the other tool factories.
 * @returns The provider-neutral tool spec consumed by `wrapTool`.
 */
export function resultPublishSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof ResultPublishParams> {
  return {
    name: 'result_publish',
    label: 'Publish Result',
    description:
      'Publish the final answer as a validated Brief. This is the ONLY way to complete a task — ' +
      'raw chat text is not a completed result. Call it once, when your answer is ready, with ' +
      '{"brief": {"title": ..., "overview": ...}}; the web pages you consulted are attached as ' +
      'sources automatically, so you never need to list URLs. Do NOT call it before gathering ' +
      'the evidence you need, and do NOT invent facts or URLs; invalid Briefs are rejected with ' +
      'the specific problems to fix.',
    parameters: ResultPublishParams,
    sanitizationProfile: 'public',
    run: (params: ResultPublishParamsType, ctx): Promise<DomainResult> =>
      runPublish(params, ctx.services),
  };
}

async function runPublish(
  params: ResultPublishParamsType,
  services: RunServices,
): Promise<DomainResult> {
  // The action phase closing is the single-successful-publication latch.
  if (services.actionPhase.isClosed()) {
    return {
      ok: false,
      errorCode: 'ALREADY_PUBLISHED',
      message: 'A result has already been published for this run.',
      retryable: false,
    };
  }

  // Ledger-authoritative composition applies to agent-authored content only:
  // a complete protocol Brief (internal/scripted callers) owns its sources and
  // typed findings, so it passes through untouched.
  const evidence = services.evidence.entries();
  const content =
    evidence.length > 0 && !isCompleteBrief(params.brief)
      ? withLedgerEvidence(params.brief, evidence)
      : params.brief;
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
    details: { brief_id: result.value.brief.brief_id },
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
