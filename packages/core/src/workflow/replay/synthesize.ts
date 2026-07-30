/**
 * The replay Synthesize stage (FEAT-FP-001, TASK-005).
 *
 * A replayed workflow that declares `synthesis:` ends the way `ask`, `research`,
 * and `do` end: with a Brief. This module is the adapter between the two worlds —
 * it maps the run's {@link ReplayEvidenceEntry} ledger onto the `SynthesisInput`
 * the existing Synthesize stage already consumes, then hands off to
 * `selectSynthesizer`. **No second synthesis engine is introduced**: clustering,
 * citation validation, the bounded re-prompt loop, and the deterministic
 * fallback all stay in `packages/core/src/synthesis/`.
 *
 * ```text
 * evidence ledger ──► SynthesisDoc[] ──► SynthesisInput ─┐
 * synthesisSpec   ──► SynthesisOptions ──────────────────┴─► selectSynthesizer ──► Brief
 * ```
 *
 * Two invariants govern the stage:
 *
 * - **Sources are engine-owned.** They derive from what `extract` actually read;
 *   a model may author prose but never couriers a URL into the document.
 * - **It is best-effort.** A workflow's value is the data it collected. A
 *   synthesis failure — no evidence, a dead provider, output that never
 *   validates, an unwritable run directory — degrades to a plainer Brief or to
 *   no Brief, and must never turn a green run red.
 */

import type { Brief } from '@yantra/protocol';

import type { BriefArtifactPaths } from '../../brief/write-artifacts.js';
import { writeBriefArtifacts } from '../../brief/write-artifacts.js';
import type { Logger } from '../../browser/types.js';
import type { ReplayEvidenceEntry } from '../../executor/evidence-ledger.js';
import { selectSynthesizer } from '../../synthesis/select.js';
import type {
  SynthesisDoc,
  SynthesisInput,
  SynthesisOptions,
  SynthesisOutcome,
  SourceFailure,
  Synthesizer,
} from '../../synthesis/types.js';

import type { RunSynthesisRecord } from './types.js';

/** Run identity an LLM strategy needs before it can open a session. */
export interface SynthesisRunContext {
  /** The owning run id. */
  readonly runId: string;
  /** The owning run directory — where the provider session log belongs. */
  readonly runDir: string;
}

/** The strategies available to one Synthesize stage. */
export interface SynthesisStrategies {
  /** Always present — determinism is always reachable, and needs no run identity. */
  readonly deterministic: Synthesizer;
  /**
   * Builds the LLM strategy for one run, or null when no provider was wired.
   *
   * A **factory** rather than an instance because an agent session's log is an
   * artifact of the run that opened it, and the run directory does not exist
   * until the orchestrator creates it — later than the CLI wires this up. Handing
   * over an instance built too early would scatter `agent/` session logs into
   * whatever directory the user happened to be standing in.
   */
  readonly llm: ((ctx: SynthesisRunContext) => Synthesizer) | null;
  /** True when the caller forced the deterministic path (`--no-llm`, daemon). */
  readonly noLlm: boolean;
}

/** The synthesis intent declared by the workflow. */
export interface SynthesisSpec {
  readonly goal: string;
  readonly length: 'short' | 'medium' | 'long';
  readonly detail: 'overview' | 'standard' | 'full';
}

/** Inputs to {@link synthesizeRun}. */
export interface SynthesizeRunOptions {
  /** The workflow's declared synthesis intent. */
  readonly spec: SynthesisSpec;
  /** The run's recorded source reads, oldest first. */
  readonly evidence: readonly ReplayEvidenceEntry[];
  /** How much evidence the ledger caps discarded (surfaced as a notice). */
  readonly overflowCount: number;
  /** Non-fatal step failures to report honestly in the Brief. */
  readonly failures?: readonly SourceFailure[];
  /** The workflow's `security_class`; selects the sanitizer profile. */
  readonly scope: SynthesisOptions['scope'];
  /** Owning task id (ULID) stamped as the Brief's `task_id`. */
  readonly taskId: string;
  /** Owning run id recorded in Brief metadata. */
  readonly runId: string;
  /** Owning run directory; passed to the LLM strategy factory for its session log. */
  readonly runDir: string;
  /** The available strategies plus the force-deterministic flag. */
  readonly strategies: SynthesisStrategies;
}

/**
 * Runs one synthesis over a replay's recorded evidence.
 *
 * @param opts - Spec, evidence, scope, provenance, and available strategies.
 * @returns The synthesis outcome, or null when the selected strategy failed.
 *   Never throws: a synthesizer error is logged and reported as null.
 *
 * @example
 * const outcome = await synthesizeRun({
 *   spec, evidence: ledger.entries(), overflowCount: ledger.overflowCount(),
 *   scope: workflow.security_class, taskId, runId, strategies,
 * });
 */
export async function synthesizeRun(
  opts: SynthesizeRunOptions,
  logger?: Logger,
): Promise<SynthesisOutcome | null> {
  const docs = opts.evidence.map(toSynthesisDoc);

  const input: SynthesisInput = {
    query: opts.spec.goal,
    docs,
    failures: [...(opts.failures ?? []), ...overflowFailures(opts.overflowCount)],
  };

  const synthesisOptions: SynthesisOptions = {
    // The caller has already decided whether the LLM may run (`noLlm`); asking
    // for `auto` here lets `selectSynthesizer` apply its documented scope rule
    // on top — an `authenticated` workflow stays deterministic even with a
    // provider wired.
    strategy: 'auto',
    detail: opts.spec.detail,
    length: opts.spec.length,
    scope: opts.scope,
    taskId: opts.taskId,
    runId: opts.runId,
    // Replay reads pages the workflow names; no search provider is involved.
    searchProvider: null,
  };

  // The LLM strategy is built only if it might actually be selected, so a
  // `--no-llm` run never even constructs a provider adapter.
  const llmFactory = opts.strategies.llm;
  const llm =
    llmFactory === null || opts.strategies.noLlm
      ? null
      : llmFactory({ runId: opts.runId, runDir: opts.runDir });

  const synthesizer = selectSynthesizer(synthesisOptions, {
    deterministic: opts.strategies.deterministic,
    llm,
    noLlm: opts.strategies.noLlm,
  });

  try {
    const result = await synthesizer.synthesize(input, synthesisOptions);
    if (!result.isOk) {
      logger?.warn(
        { runId: opts.runId, strategy: synthesizer.strategy, reason: result.error.message },
        'replay synthesis failed; run keeps its outputs',
      );
      return null;
    }
    logger?.info(
      {
        runId: opts.runId,
        strategy: result.value.strategyUsed,
        fallbackUsed: result.value.fallbackUsed,
        sources: result.value.brief.sources.length,
        overflowCount: opts.overflowCount,
      },
      'replay synthesis complete',
    );
    return result.value;
  } catch (error) {
    // A synthesizer is contracted to return errors, not throw. Containing a
    // contract violation here is what keeps the stage from failing the run.
    logger?.warn(
      {
        runId: opts.runId,
        strategy: synthesizer.strategy,
        error: error instanceof Error ? error.message : String(error),
      },
      'replay synthesis threw; run keeps its outputs',
    );
    return null;
  }
}

/** The three conditions a run must meet before the Synthesize stage may run. */
export interface SynthesizeGateInput {
  /** The workflow's declared intent, or null when it declared none. */
  readonly synthesisSpec: SynthesisSpec | null;
  /** The strategies the caller wired, or null when the caller disabled the stage. */
  readonly strategies: SynthesisStrategies | null;
  /** True only when the executor ran every step to completion. */
  readonly completed: boolean;
}

/**
 * The gate's verdict. When `run` is true it also carries the narrowed,
 * non-null spec and strategies, so the caller needs no second null check.
 */
export type SynthesizeGate =
  | { readonly run: false }
  | {
      readonly run: true;
      readonly spec: SynthesisSpec;
      readonly strategies: SynthesisStrategies;
    };

/**
 * Decides whether the Synthesize stage runs for this run.
 *
 * All three conditions are load-bearing:
 *
 * - **No `synthesis:` block** — the stage is opt-in, and a workflow that never
 *   asked for a Brief must behave exactly as it did before the feature existed.
 * - **No wired strategies** — the caller (a daemon fire, a nested
 *   `workflow_run`, a test) deliberately disabled the stage.
 * - **Run did not complete** — a failed run's evidence is partial by
 *   definition, and a confident Brief over half a run reads as an answer when
 *   it is not one.
 *
 * @param input - The workflow's intent, the wired strategies, and completion.
 * @returns The verdict, carrying the narrowed inputs when the stage should run.
 */
export function synthesizeGate(input: SynthesizeGateInput): SynthesizeGate {
  if (input.synthesisSpec === null || input.strategies === null || !input.completed) {
    return { run: false };
  }
  return { run: true, spec: input.synthesisSpec, strategies: input.strategies };
}

/** What {@link runSynthesizeStage} produced, for the outcome and manifest. */
export interface SynthesizeStageResult {
  /** The synthesized document, or null when the stage produced none. */
  readonly brief: Brief | null;
  /** Where the artifacts landed, or null when the write failed or was skipped. */
  readonly artifacts: BriefArtifactPaths | null;
  /** Manifest provenance, or null when no synthesis ran. */
  readonly record: RunSynthesisRecord | null;
}

/** A stage that produced nothing — the shape every skip and failure returns. */
const EMPTY_STAGE: SynthesizeStageResult = { brief: null, artifacts: null, record: null };

/**
 * The full stage as the orchestrator uses it: synthesize, persist, and report.
 *
 * Separated from {@link synthesizeRun} so the disk write and manifest record are
 * covered by the same best-effort guarantee — an unwritable run directory still
 * leaves a Brief in the outcome for the terminal to render.
 *
 * @param opts - Everything {@link synthesizeRun} needs; `runDir` also receives
 *   the artifacts.
 * @returns The Brief, its artifact paths, and the manifest record. Every field
 *   is null when the stage produced nothing.
 */
export async function runSynthesizeStage(
  opts: SynthesizeRunOptions,
  logger?: Logger,
): Promise<SynthesizeStageResult> {
  const outcome = await synthesizeRun(opts, logger);
  if (outcome === null) return EMPTY_STAGE;

  const written = await writeBriefArtifacts(opts.runDir, outcome.brief);
  if (!written.isOk) {
    // The document exists even though persistence failed; the caller can still
    // render it. Report no paths rather than paths that do not exist.
    logger?.warn(
      { runId: opts.runId, runDir: opts.runDir, reason: written.error.message },
      'brief artifacts not written; run keeps its outputs',
    );
    return {
      brief: outcome.brief,
      artifacts: null,
      record: {
        strategy: outcome.strategyUsed,
        fallbackUsed: outcome.fallbackUsed,
        briefPath: null,
      },
    };
  }

  return {
    brief: outcome.brief,
    artifacts: written.value,
    record: {
      strategy: outcome.strategyUsed,
      fallbackUsed: outcome.fallbackUsed,
      briefPath: written.value.jsonPath,
    },
  };
}

/**
 * Projects one recorded read onto a synthesis doc.
 *
 * Ledger order is read order, which the synthesis stage treats as rank order —
 * the reasonable reading for replay, where the workflow author chose the pages
 * and their sequence. `publishedAt` and `excerpt` are null: a replayed page read
 * carries no publication metadata.
 */
function toSynthesisDoc(entry: ReplayEvidenceEntry): SynthesisDoc {
  return {
    url: entry.url,
    finalUrl: entry.finalUrl,
    host: entry.host,
    title: entry.title,
    fetchedAt: entry.fetchedAt,
    publishedAt: null,
    text: entry.text,
    excerpt: null,
  };
}

/**
 * Turns ledger overflow into an honest notice.
 *
 * A Brief built from a trimmed ledger is built from less than the run read, and
 * the reader is entitled to know that rather than silently receiving a thinner
 * document.
 */
function overflowFailures(overflowCount: number): readonly SourceFailure[] {
  if (overflowCount <= 0) return [];
  return [
    {
      url: '',
      host: 'yantra',
      stage: 'extract',
      reason: `${overflowCount} recorded read(s) were dropped or truncated by the evidence-ledger caps.`,
    },
  ];
}
