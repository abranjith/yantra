/**
 * Run-scoped agent trace accumulator (FEAT-027 TASK-003).
 *
 * As the browser tools successfully act on a page, they append an
 * {@link AgentTraceStep} here — the ordered record of *what worked*. This trace
 * is the raw material for promotion (`yantra do --save-as`, TASK-004): each
 * successful navigate/click/fill/extract becomes a workflow step, so one-off
 * agent effort can compound into a deterministic, replayable workflow.
 *
 * Two hard rules the accumulator enforces by shape:
 *
 * 1. **Candidate chains, never opaque refs.** Click/fill/extract steps carry a
 *    resolved candidate-chain locator ({@link LocatorCandidate}[]) derived from
 *    the observation's internal role/name — never the run-scoped `eN` ref, which
 *    is meaningless outside the live page.
 * 2. **Secret references, never secret values.** A fill performed with a website
 *    secret records only the `SecretRef` key; the resolved value never enters the
 *    trace, `trace.json`, or the promoted workflow.
 *
 * The trace lives in memory during the run and is written to
 * `runs/<id>/trace.json` at finalize.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocatorCandidate, RoleEnum } from '@yantra/protocol';
import { z } from 'zod';

type LocatorCandidateType = z.infer<typeof LocatorCandidate>;

/** A fill value: a non-secret literal, or an opaque website-secret reference. */
export type TraceFillValue =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'secret_ref'; readonly key: string };

/** One recorded successful interaction, ordered by execution. */
export type AgentTraceStep =
  | {
      readonly kind: 'navigate';
      readonly host: string;
      readonly url: string;
      readonly requires_confirmation: boolean;
    }
  | {
      readonly kind: 'click';
      readonly host: string;
      readonly locator: readonly LocatorCandidateType[];
      readonly requires_confirmation: boolean;
    }
  | {
      readonly kind: 'fill';
      readonly host: string;
      readonly locator: readonly LocatorCandidateType[];
      readonly value: TraceFillValue;
      readonly submit: boolean;
      readonly requires_confirmation: boolean;
    }
  | {
      readonly kind: 'fill_element';
      readonly host: string;
      readonly field: {
        readonly role: string;
        readonly name: string;
        readonly group: string | null;
      };
      readonly locator: readonly LocatorCandidateType[];
      readonly value: TraceFillValue;
      readonly requires_confirmation: boolean;
    }
  | {
      readonly kind: 'extract';
      readonly host: string;
      readonly extractionKind: 'content' | 'table';
      readonly requires_confirmation: boolean;
    }
  | {
      /**
       * A page read via `browser_observe`. Recorded because an agentic run
       * routinely *ends* by observing — the digest already answers the user's
       * question, so the model never calls `browser_extract`. Promotion turned
       * such a run into a workflow that clicked through and captured nothing,
       * because only extracts became steps.
       *
       * Observes made mid-run are navigation aids, not data collection, so
       * promotion keeps only a trailing one. See `promoteAgentTrace`.
       */
      readonly kind: 'observe';
      readonly host: string;
      readonly requires_confirmation: boolean;
    };

/** The persisted `trace.json` document. */
export interface AgentTraceFile {
  readonly version: 1;
  readonly steps: readonly AgentTraceStep[];
}

const TraceFillValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }).strict(),
  z.object({ kind: z.literal('secret_ref'), key: z.string() }).strict(),
]);

const AgentTraceStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('navigate'),
      host: z.string(),
      url: z.string(),
      requires_confirmation: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('click'),
      host: z.string(),
      locator: z.array(LocatorCandidate).min(1),
      requires_confirmation: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fill'),
      host: z.string(),
      locator: z.array(LocatorCandidate).min(1),
      value: TraceFillValueSchema,
      submit: z.boolean(),
      requires_confirmation: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fill_element'),
      host: z.string(),
      field: z
        .object({ role: z.string(), name: z.string(), group: z.string().nullable() })
        .strict(),
      locator: z.array(LocatorCandidate).min(1),
      value: TraceFillValueSchema,
      requires_confirmation: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('extract'),
      host: z.string(),
      extractionKind: z.enum(['content', 'table']),
      requires_confirmation: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('observe'),
      host: z.string(),
      requires_confirmation: z.boolean(),
    })
    .strict(),
]);

/** Closed schema for the persisted `trace.json` document. */
export const AgentTraceFileSchema = z
  .object({
    version: z.literal(1),
    steps: z.array(AgentTraceStepSchema),
  })
  .strict();

/** Valid ARIA role intents accepted by the workflow locator schema. */
const VALID_ROLES = new Set<string>(RoleEnum.options);

/**
 * Degraded fallback used only when the locator engine cannot derive a chain
 * from the live element (`AgentBrowserController.locatorFor`). Prefers a role
 * candidate (role + accessible name); falls back to a label candidate when the
 * role is not a modelled ARIA intent but a name is known.
 *
 * The observed role comes from the observation scanner, whose role map is a
 * simplification of the locator engine's — so a chain built here is a
 * best-effort guess, not the authority. Roles are passed through verbatim
 * rather than aliased: rewriting `searchbox`→`textbox` or `listbox`→`combobox`
 * (as this once did) produces a role the engine never computes for that
 * element, guaranteeing a replay miss. An unrepresentable role now degrades to
 * a name-based candidate, which at least has a chance of matching.
 *
 * @param role - The observed ARIA role.
 * @param name - The observed accessible name (may be empty).
 * @returns A one-entry candidate chain suitable for a workflow `_locators` block.
 */
export function toCandidateChain(role: string, name: string): LocatorCandidateType[] {
  if (VALID_ROLES.has(role)) {
    // `role` is a verified RoleEnum member; the cast narrows the literal.
    return [{ kind: 'role', role, name } as LocatorCandidateType];
  }
  if (name.length > 0) {
    return [{ kind: 'label', value: name }];
  }
  // No usable role or name — degrade to a generic button role rather than emit
  // a schema-invalid candidate.
  return [{ kind: 'role', role: 'button', name: '' }];
}

/**
 * In-memory, run-scoped ordered accumulator of successful interactions.
 */
export class AgentTrace {
  private readonly recorded: AgentTraceStep[] = [];

  /** Append one successful interaction to the trace, in execution order. */
  public append(step: AgentTraceStep): void {
    this.recorded.push(step);
  }

  /** The ordered steps recorded so far. */
  public steps(): readonly AgentTraceStep[] {
    return this.recorded;
  }

  /** True when no interaction has been recorded. */
  public isEmpty(): boolean {
    return this.recorded.length === 0;
  }

  /**
   * Writes `trace.json` to the run directory. The document contains only
   * candidate chains and secret *references* — no opaque refs, no resolved
   * secret values.
   *
   * @param runDir - The owning run directory.
   */
  public async finalize(runDir: string): Promise<void> {
    const file: AgentTraceFile = { version: 1, steps: this.recorded };
    await writeFile(join(runDir, 'trace.json'), `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
