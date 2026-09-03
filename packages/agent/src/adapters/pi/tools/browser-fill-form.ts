import { parseFillValue, resolveDatePair, type WidgetTarget } from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import {
  actionMetadataSink,
  browserController,
  browserWidgetPort,
  deltaAfterAction,
  deltaDetails,
  drainFillMetadata,
  followSiteOpenedTab,
  isDomainFailure,
  mapFillFailure,
  modelActionMetadata,
  modelDelta,
  modelObservation,
  recordActionProvenance,
  resolveFillField,
  resolveFillTarget,
  type ResolvedFillField,
} from './browser-common.js';
import { applyBrowserFill, type AppliedBrowserFill } from './browser-fill-element.js';

const BrowserFillFormParams = Type.Object(
  {
    fields: Type.Array(
      Type.Object(
        {
          field: Type.String({
            minLength: 1,
            maxLength: 200,
            description: 'Visible accessible field name or current eNN ref.',
          }),
          value: Type.String({
            maxLength: 4096,
            description:
              'Non-secret text, offered option, checked state, ISO date, or ISO date range.',
          }),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: 10,
        description:
          'Fields to fill in order. A field that fails does not end the batch: the rest are still attempted, except any that belong to the same widget as the one that failed.',
      },
    ),
  },
  { additionalProperties: false },
);

type Params = Static<typeof BrowserFillFormParams>;

/** Build the ordered multi-control fill tool. */
export function browserFillFormSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserFillFormParams> {
  return {
    name: 'browser_fill_form',
    label: 'Browser Fill Form',
    description:
      'Preferred way to fill a form: set every non-secret control it needs in one ordered call, through the same semantic engine as browser_fill_element, including dates, ranges, choices, toggles, and suggestions. Use this whenever two or more fields need values — a search form is one call, not one call per field. Use browser_fill_element for a credential or a lone field. Each applied field reports requested, committed, and resolution, so a committed value that differs from what you sent reads as the widget resolving it rather than as a failure. A field that fails does not end the batch: the result carries applied (what landed), failed (each with observed, attempted recovery verdicts, and any offered choices), and skipped (fields belonging to the same widget as a failed one, which must wait until that field is resolved). Partial success is progress to build on, not a reason to re-send the fields that worked. The result also carries one delta for the whole call: what changed between the page you last saw and the page the batch left behind — URL, dialogs opened or closed, how many elements appeared or vanished, where focus went — which describes the call window rather than claiming these fills caused every change, and says complete: false with a reason wherever a bound stopped it being definite. Do not use this tool to submit the form.',
    parameters: BrowserFillFormParams,
    sanitizationProfile: 'authenticated',
    mutating: true,
    run: (params: Params, ctx): Promise<DomainResult> => runFillForm(params, ctx.services),
  };
}

/** A field the batch attempted and could not fill. */
interface FailedField {
  readonly field: string;
  readonly error_code: string;
  readonly message: string;
  readonly observed?: unknown;
  readonly offered?: unknown;
  readonly attempted?: unknown;
  /**
   * What covered the field, when something did.
   *
   * Failure `details` are not model-visible — the middleware sends only the
   * code, message and retryable flag — so a batch that reports per-field
   * failures has to lift the obstruction into the model-visible entry itself.
   */
  readonly kind?: unknown;
  readonly obstruction?: unknown;
}

/** A field the batch did not attempt, and what is blocking it. */
interface SkippedField {
  readonly field: string;
  readonly reason: 'same-widget-group-as-failed';
  readonly blocked_by: string;
}

/**
 * Fill every field, and let a failure stop only what it actually blocks.
 *
 * Stopping at the first failure made a four-field call return `applied: []` —
 * a call that existed to make four fields' worth of progress made none, and the
 * three untouched fields were indistinguishable from three that had been tried
 * and refused. Every remaining field is therefore attempted, **except** those
 * belonging to the same widget group as the failed one: a shared range picker
 * or a single overlay would fail again for a reason the caller cannot tell
 * apart from a real problem with that field.
 *
 * Dependence is read from the observation's `group`, captured when the control
 * was observed, and never from field ordering. It is deliberately not read from
 * a live container: a failed fill dismisses whatever it opened, so resolving a
 * container afterwards commonly answers null, and a rule written that way would
 * quietly never fire.
 */
async function runFillForm(params: Params, services: RunServices): Promise<DomainResult> {
  for (const spec of params.fields) {
    const parsed = parseFillValue(spec.value, 'textbox');
    if (!('kind' in parsed)) {
      return { ...mapFillFailure(parsed), details: { ...parsed.details, applied: [] } };
    }
  }
  const controller = browserController(services);
  if (isDomainFailure(controller)) return controller;
  const plan = await fuseDatePair(params.fields, services);
  // One collector for the whole batch, so a popup one field opened is
  // attributed to this call once — not once per field, and not to the next tool.
  const sink = actionMetadataSink();
  const applied: AppliedBrowserFill[] = [];
  const failed: FailedField[] = [];
  const skipped: SkippedField[] = [];
  /** The widget group a failure has made unreadable, and the field that owns it. */
  let blocked: { readonly group: string; readonly field: string } | null = null;

  for (const spec of plan) {
    let preresolved: ResolvedFillField | undefined;
    if (blocked !== null) {
      // Resolving up front only happens once something has failed, so the
      // ordinary path pays nothing — and the resolution is handed to the fill
      // rather than performed twice.
      const resolved = await resolveFillField(spec.field, controller);
      if (!isDomainFailure(resolved)) {
        if (resolved.target.group !== null && resolved.target.group === blocked.group) {
          skipped.push({
            field: spec.field,
            reason: 'same-widget-group-as-failed',
            blocked_by: blocked.field,
          });
          continue;
        }
        preresolved = resolved;
      }
    }

    const outcome = await applyBrowserFill(spec.field, spec.value, services, preresolved, sink);
    if (isDomainFailure(outcome)) {
      const details = asDetails(outcome.details);
      failed.push({
        field: spec.field,
        error_code: outcome.errorCode,
        message: outcome.message,
        ...(details.observed === undefined ? {} : { observed: details.observed }),
        ...(details.offered === undefined ? {} : { offered: details.offered }),
        ...(details.attempted === undefined ? {} : { attempted: details.attempted }),
        ...(details.kind === undefined ? {} : { kind: details.kind }),
        ...(details.obstruction === undefined ? {} : { obstruction: details.obstruction }),
      });
      const group = outcome.target?.group ?? null;
      if (group !== null) blocked = { group, field: spec.field };
      continue;
    }
    // A fused range is reported as the one fill it was, listing both field
    // names it accounts for. Emitting a second entry would have to invent a ref
    // for a control that was never driven.
    applied.push(spec.covers.length > 1 ? { ...outcome, covers: spec.covers } : outcome);
  }

  const metadata = drainFillMetadata(controller, sink);
  recordActionProvenance(services, metadata);
  // Followed before the final read, so an adopted tab is the page the batch's
  // observation and delta describe.
  const followed = await followSiteOpenedTab(services, controller, metadata);
  const observation = await controller.observe();
  // One delta for the whole batch, from this single final observation. The
  // baseline is the frame the model last saw — pinned when the tool call
  // opened — so the many internal `trackDigest: false` reads a batch takes
  // while resolving fields cannot narrow it to the difference from a page the
  // model was never shown.
  const delta = deltaAfterAction(controller);
  // Counts ride in `details` so the audit projection can see them. The
  // middleware records `status: "ok"` for any successful result, and report.md
  // renders one line per call from that projection — a partial batch that
  // appeared there as a flat `ok` would hide exactly the kind of defect this
  // feature exists to surface.
  const counts = {
    partial: applied.length > 0 && failed.length > 0,
    applied_count: applied.length,
    failed_count: failed.length,
    skipped_count: skipped.length,
  };

  if (applied.length === 0 && failed.length > 0) {
    const first = failed[0]!;
    return {
      ok: false,
      errorCode: first.error_code,
      message: first.message,
      retryable: true,
      details: { ...counts, applied, failed, skipped },
    };
  }

  return {
    ok: true,
    model: {
      applied,
      ...(failed.length > 0 ? { failed } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
      ...modelActionMetadata(followed),
      observation: modelObservation(observation),
      ...(delta ? { delta: modelDelta(delta) } : {}),
      note:
        failed.length > 0
          ? 'Nothing was submitted, and some fields did not take. The applied fields are set — do not re-send them.'
          : 'Nothing was submitted. Activate the submit/search control with browser_click.',
    },
    details: {
      fields: applied.length,
      ...counts,
      ...deltaDetails(observation, delta ?? undefined),
    },
  };
}

/** One fill to perform, and the caller's field names it accounts for. */
interface PlannedFill {
  readonly field: string;
  readonly value: string;
  readonly covers: readonly string[];
}

/**
 * Collapse the two ends of one date range into a single range fill.
 *
 * A picker that spreads a range over a check-in/check-out pair commits the pair
 * and nothing less: filling one end clears the other, and releasing the widget
 * there discards the choice. Driven as two independent fills the first one can
 * therefore never survive, however carefully it is retried — the caller has to
 * be asking for a range for the widget to have anything it can accept. When a
 * caller sends both ends in one call it *is* asking for a range, so the tool
 * says so rather than taking the request apart and failing on the first half.
 *
 * Fusion needs both ends to be unambiguous, so it applies only when the request
 * holds exactly two dates, the page resolves exactly one control per side, and
 * those controls are the two fields named. Anything else fills in order as
 * before, and a page with a single-date picker is untouched by this.
 */
async function fuseDatePair(
  fields: readonly { readonly field: string; readonly value: string }[],
  services: RunServices,
): Promise<readonly PlannedFill[]> {
  const asIs = fields.map((spec) => ({ ...spec, covers: [spec.field] }));
  const dates = fields.filter((spec) => {
    const parsed = parseFillValue(spec.value, 'textbox');
    return 'kind' in parsed && parsed.kind === 'date';
  });
  if (dates.length !== 2) return asIs;

  const controller = browserController(services);
  if (isDomainFailure(controller)) return asIs;
  const first = await resolveFillTarget(dates[0]!.field, controller);
  if (isDomainFailure(first)) return asIs;
  const pair = await resolveDatePair(browserWidgetPort(controller, services.now), first);
  if (!pair) return asIs;

  const from = dates.find((spec) => names(spec.field, pair.from));
  const to = dates.find((spec) => names(spec.field, pair.to));
  if (!from || !to || from === to) return asIs;
  // A reversed range is the caller's mistake, not something to quietly reorder.
  // Left unfused it is reported by the engine against the field they named.
  if (from.value.trim() > to.value.trim()) return asIs;

  const fused: PlannedFill = {
    field: from.field,
    value: `${from.value.trim()}..${to.value.trim()}`,
    covers: [from.field, to.field],
  };
  // Position is preserved: the range takes the place of the first end named,
  // and any non-date fields keep filling in the order the caller asked for.
  return fields.flatMap((spec) =>
    spec === to ? [] : [spec === from ? fused : { ...spec, covers: [spec.field] }],
  );
}

/** True when a caller's field string denotes this side of the pair. */
function names(field: string, side: WidgetTarget): boolean {
  const wanted = field.trim().toLocaleLowerCase();
  return field === side.ref || side.name.trim().toLocaleLowerCase() === wanted;
}

function asDetails(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
