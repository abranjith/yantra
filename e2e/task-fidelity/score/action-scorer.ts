/** Fixture-derived task truth, independent of the runtime's verification verdicts. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as AgentRuntime from '@yantra/agent';
import * as Protocol from '@yantra/protocol';
import { z } from 'zod';

import type { ScenarioRun } from '../runner.js';
import type { ActionTruth, ValueRule } from '../scenario.js';

import type { Score } from './scorer.js';

export interface ActionScore {
  readonly field_correctness: Score;
  readonly exempt_untouched: Score;
  readonly submissions: number;
  readonly capture: Score;
  readonly item_agreement: Score;
  readonly outcome_agreement: boolean | null;
  readonly reported_success: boolean;
  readonly task_success: boolean;
}
export interface TimingScore {
  readonly tool_ms: number;
  readonly reasoning_tokens: number | null;
  readonly retries: number;
  readonly captures: number;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function score(decisions: readonly { readonly passed: boolean; readonly detail: string }[]): Score {
  const numerator = decisions.filter((decision) => decision.passed).length;
  return {
    value: decisions.length === 0 ? null : numerator / decisions.length,
    numerator,
    denominator: decisions.length,
    detail: decisions.map((decision) => `${decision.passed ? 'pass' : 'fail'}: ${decision.detail}`),
  };
}
function all(score: Score): boolean {
  return score.denominator === score.numerator;
}

/** Closed, authored rules: an engine-reported success is never an input. */
export function valueMatches(value: string | undefined, rule: ValueRule): boolean {
  if (value === undefined) return false;
  switch (rule.kind) {
    case 'nonempty':
      return value.trim().length > 0;
    case 'letters':
      return /^[\p{L}][\p{L}\p{M} .'-]*$/u.test(value.trim());
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case 'digits':
      return /^\d+$/u.test(value) && value.length >= rule.min && value.length <= rule.max;
    case 'number':
      return (
        value.trim() !== '' &&
        Number.isFinite(Number(value)) &&
        Number(value) >= rule.min &&
        Number(value) <= rule.max
      );
    case 'date':
      return (
        /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value
      );
    case 'choice':
      return value.trim() !== '' && !/^(?:choose|select|pick)\b/iu.test(value);
    case 'protected':
      return (
        /^[a-f0-9]{64}$/u.test(value) && value !== createHash('sha256').update('').digest('hex')
      );
    case 'checked-any':
    case 'untouched':
      return false;
  }
}

// Namespace access is intentional: the baseline pipeline predates these exports.
const CaptureRefSchema =
  Protocol.ArtifactRef ??
  z
    .object({
      kind: z.literal('screenshot'),
      path: z.string().regex(/^screenshots\/(?:capture-)?\d+-[a-f0-9]{12}(?:-p\d+)?\.png$/u),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      mime_type: z.literal('image/png'),
      bytes: z.number().int().nonnegative(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      sent_to_model: z.boolean(),
    })
    .strict();
function auditArtifactRefs(entry: Protocol.ToolAuditEntry): Protocol.ArtifactRef[] {
  if (typeof Protocol.artifactRefsOf === 'function') return Protocol.artifactRefsOf(entry);
  return array(record(entry).captures).flatMap((capture) => {
    const parsed = CaptureRefSchema.safeParse({
      ...record(capture),
      kind: 'screenshot',
      sent_to_model: true,
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/** Validate every part of one linked capture, including bytes, dimensions and hash. */
export function validPng(runDir: string, input: unknown): boolean {
  const parsed = CaptureRefSchema.safeParse({
    sent_to_model: record(input).sent_to_model ?? false,
    // BriefArtifact carries scope/part information beside the common reference.
    kind: record(input).kind,
    path: record(input).path,
    sha256: record(input).sha256,
    mime_type: record(input).mime_type ?? 'image/png',
    bytes: record(input).bytes,
    width: record(input).width,
    height: record(input).height,
  });
  // Parse only the reference projection, never trust an unchecked path.
  if (!parsed.success) return false;
  try {
    const ref = parsed.data;
    const bytes = readFileSync(join(runDir, ref.path));
    return (
      bytes.length >= 33 &&
      bytes.length === ref.bytes &&
      bytes.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')) &&
      bytes.readUInt32BE(8) === 13 &&
      bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.readUInt32BE(16) === ref.width &&
      bytes.readUInt32BE(20) === ref.height &&
      createHash('sha256').update(bytes).digest('hex') === ref.sha256
    );
  } catch {
    return false;
  }
}

function captureDecisions(
  run: ScenarioRun,
  truth: ActionTruth,
): { passed: boolean; detail: string }[] {
  const brief = record(run.artifacts.brief);
  const linked = array(brief.artifacts).map(record);
  const audit = (run.artifacts.toolCalls?.lines ?? []).flatMap((line) => {
    const parsed = Protocol.ToolAuditEntry.safeParse(line);
    if (!parsed.success || parsed.data.phase !== 'end' || parsed.data.status !== 'ok') return [];
    const output = record(parsed.data.output_sanitized);
    const details = record(output.details);
    const scope =
      record(details.capture_set).scope ?? record(parsed.data.input_sanitized).scope ?? 'viewport';
    return auditArtifactRefs(parsed.data).map((ref) => ({ ...ref, scope }));
  });
  // Only older pipelines lack Brief artifact links. A current run must link
  // its capture in the Brief, even when the audit proves the PNG was written.
  const historical =
    Protocol.ArtifactRef === undefined ||
    (record(run.artifacts.manifest).taskOutcome === undefined &&
      record(run.outcome).taskOutcome === undefined);
  const candidates = linked.length > 0 ? linked : historical ? audit : [];
  return truth.artifacts.map((scope) => {
    const refs = candidates.filter(
      (ref) => ref.scope === scope || (scope === 'viewport' && ref.scope === 'full_page'),
    );
    const passed =
      refs.length > 0 &&
      refs.every(
        (ref) =>
          validPng(run.runDir, ref) && (scope !== 'full_page' || record(ref).complete !== false),
      ) &&
      refs.every(
        (ref) =>
          record(ref).parts === undefined ||
          refs.filter((other) => other.parts === ref.parts).length >= Number(ref.parts),
      );
    return {
      passed,
      detail: `${scope}: ${passed ? 'valid linked PNG' : 'missing, incomplete or invalid PNG'}`,
    };
  });
}

/** Score action fulfillment from the server witness and persisted public surfaces. */
export function scoreActions(run: ScenarioRun, truth: ActionTruth): ActionScore {
  const state = run.formState[truth.page];
  const initial = run.formInitialState?.[truth.page];
  const fields: { passed: boolean; detail: string }[] = [];
  const exempt: { passed: boolean; detail: string }[] = [];
  const groups = new Set<string>();
  for (const [key, rule] of Object.entries(truth.rules)) {
    const control = state?.controls[key];
    if (rule.kind === 'untouched') {
      const original = initial?.controls[key];
      const intended = truth.intended?.[key];
      exempt.push({
        passed:
          control !== undefined &&
          (original !== undefined
            ? JSON.stringify(control) === JSON.stringify(original)
            : intended !== undefined &&
              (typeof intended === 'boolean'
                ? control.checked === intended
                : control.value === intended)),
        detail: key,
      });
    } else if (rule.kind === 'checked-any') {
      if (groups.has(rule.group)) continue;
      groups.add(rule.group);
      const keys = Object.entries(truth.rules)
        .filter(
          ([, candidate]) => candidate.kind === 'checked-any' && candidate.group === rule.group,
        )
        .map(([candidate]) => candidate);
      fields.push({
        passed:
          keys.every((candidate) => state?.controls[candidate] !== undefined) &&
          keys.some((candidate) => state?.controls[candidate]?.checked === true),
        detail: keys.join(', '),
      });
    } else
      fields.push({
        passed:
          control !== undefined &&
          valueMatches(rule.kind === 'protected' ? control.digest : control.value, rule),
        detail: key,
      });
  }
  const field_correctness = score(fields);
  const exempt_untouched = score(exempt);
  const submissions =
    state === undefined ? 0 : state.submits + state.requestSubmitCalls + state.formSubmitCalls;
  const captures = captureDecisions(run, truth);
  const capture = score(captures);
  const fillMet = fields.length > 0 && all(field_correctness);
  const changed =
    state !== undefined &&
    Object.entries(state.controls).some(([key, control]) => {
      const before = initial?.controls[key];
      return before !== undefined
        ? JSON.stringify(control) !== JSON.stringify(before)
        : (control.value?.length ?? 0) > 0 || control.checked === true;
    });
  const requirements = array(record(run.artifacts.brief).requirements).map(record);
  const item_agreement = score(
    requirements.map((item) => {
      const id = String(item.id);
      const met =
        id === 'fill'
          ? fillMet
          : id === 'effects.submit'
            ? state !== undefined && submissions === 0
            : id.startsWith('artifact:screenshot:')
              ? captures.find((entry) => entry.detail.startsWith(`${id.split(':')[2]}:`))
                  ?.passed === true
              : id === 'deliverable'
                ? changed || (state?.clicks ?? 0) > 0
                : false;
      return {
        passed: item.status === (met ? 'met' : 'unmet'),
        detail: `${id}: fixture ${met ? 'met' : 'unmet'}, reported ${String(item.status)}`,
      };
    }),
  );
  const manifestOutcome = record(run.artifacts.manifest).taskOutcome;
  const outcome = AgentRuntime.taskOutcomeOf?.(run.outcome) ?? run.outcome.kind;
  const surfaces = run.surfaces;
  const outcome_agreement =
    manifestOutcome === undefined
      ? null
      : surfaces !== null &&
        surfaces !== undefined &&
        manifestOutcome === outcome &&
        record(surfaces.json).task_outcome === outcome &&
        surfaces.firstLine.split(/[:.\s]/u)[0]?.toLowerCase() === outcome &&
        surfaces.exitCode === record(record(AgentRuntime.TASK_OUTCOME_TABLE)[outcome]).exitCode;
  // Historical pipelines predate per-item requirements and the outcome enum.
  // Their published result is the reported-success surface; browser truth still judges delivery.
  const historical = manifestOutcome === undefined && record(run.outcome).taskOutcome === undefined;
  const reported_success =
    outcome === 'fulfilled' || (historical && run.outcome.kind === 'published');
  return {
    field_correctness,
    exempt_untouched,
    submissions,
    capture,
    item_agreement,
    outcome_agreement,
    reported_success,
    task_success:
      state !== undefined &&
      fillMet &&
      all(exempt_untouched) &&
      (truth.submit === 'allowed' || submissions === 0) &&
      all(capture) &&
      (historical ||
        (item_agreement.denominator > 0 && all(item_agreement) && outcome_agreement === true)) &&
      reported_success,
  };
}

/** Observational cost telemetry, tolerant of historical runs. */
export function actionTiming(run: ScenarioRun): TimingScore {
  const entries = (run.artifacts.toolCalls?.lines ?? []).map(record);
  const ends = entries.filter((entry) => entry.phase === 'end');
  const refs = new Map<string, Set<unknown>>();
  const aliases = new Map<string, string>();
  // Results establish which opaque ref a label resolved to. Reusing that label
  // or switching to its offered ref must count as driving the same control.
  for (const entry of ends) {
    const output = record(entry.output_sanitized);
    const details = record(output.details);
    const model = record(output.model);
    for (const result of [...array(details.applied), ...array(model.applied), details, model]) {
      const applied = record(result);
      if (typeof applied.field === 'string' && typeof applied.ref === 'string')
        aliases.set(applied.field, applied.ref);
    }
  }
  for (const [index, entry] of ends.entries()) {
    if (entry.tool !== 'browser_fill_form' && entry.tool !== 'browser_fill_element') continue;
    const input = record(
      entries.find((start) => start.phase === 'start' && start.call_id === entry.call_id)
        ?.input_sanitized ?? entry.input_sanitized,
    );
    for (const field of entry.tool === 'browser_fill_form' ? array(input.fields) : [input]) {
      const target = record(field);
      const named = target.ref ?? target.field ?? target.query;
      if (typeof named !== 'string') continue;
      const key = aliases.get(named) ?? named;
      const calls = refs.get(key) ?? new Set();
      calls.add(entry.call_id ?? index);
      refs.set(key, calls);
    }
  }
  const reasoning = array(record(run.artifacts.usage).calls)
    .map(record)
    .map((call) => call.reasoning_tokens)
    .filter((value): value is number => typeof value === 'number');
  const totalReasoning = record(record(run.artifacts.usage).totals).reasoning_tokens;
  return {
    tool_ms: Math.round(
      ends.reduce(
        (sum, entry) => sum + (typeof entry.duration_ms === 'number' ? entry.duration_ms : 0),
        0,
      ),
    ),
    reasoning_tokens:
      reasoning.length > 0
        ? reasoning.reduce((a, b) => a + b, 0)
        : typeof totalReasoning === 'number'
          ? totalReasoning
          : null,
    retries: [...refs.values()].filter((calls) => calls.size > 1).length,
    captures: ends.filter(
      (entry) =>
        ['browser_capture', 'browser_screenshot'].includes(String(entry.tool)) &&
        entry.status === 'ok' &&
        (array(entry.artifacts).length > 0 || array(entry.captures).length > 0),
    ).length,
  };
}
