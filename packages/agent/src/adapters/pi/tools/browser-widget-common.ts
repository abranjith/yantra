import {
  createDefaultWidgetRegistry,
  defaultWidgetBudget,
  type AgentBrowserController,
  type WidgetFamily,
  type WidgetFailure,
  type WidgetIntent,
  type WidgetPort,
  type WidgetTarget,
} from '@yantra/core';

import type { DomainFailure, DomainResult } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { toCandidateChain } from '../../../runtime/trace.js';

import {
  browserController,
  browserFailure,
  isDomainFailure,
  modelObservation,
  safeLocatorFor,
} from './browser-common.js';
import { resolveFormField } from './form-field-resolve.js';

/** Internal observation cap used for field and structural ref resolution. */
export const WIDGET_RESOLUTION_CAP = 400;

/** Credential shapes refused by all non-credential widget/form tools. */
export const SECRET_SHAPE =
  /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/;

/** Drive one semantic widget intent and return its post-action observation. */
export async function runWidgetIntent(
  field: string,
  intent: WidgetIntent,
  family: WidgetFamily,
  services: RunServices,
): Promise<DomainResult> {
  const controller = browserController(services);
  if (isDomainFailure(controller)) return controller;
  const resolved = await resolveWidgetTarget(field, controller);
  if (isDomainFailure(resolved)) return resolved;
  const port = tracedWidgetPort(controller, services, { field, target: resolved });
  let outcome;
  try {
    outcome = await createDefaultWidgetRegistry().driveWidget(
      port,
      resolved,
      intent,
      defaultWidgetBudget(port),
      family,
    );
  } catch (error) {
    if (isStaleRefError(error)) return elementReplacedFailure(field, resolved);
    return browserFailure(error);
  }
  if (!outcome.ok) {
    return mapWidgetFailure(outcome);
  }
  const observation = await controller.observe();
  return {
    ok: true,
    model: {
      committed: outcome.committed,
      driver: outcome.driver,
      ...modelObservation(observation),
    },
    details: { actions: outcome.actions },
  };
}

/** Preserve a core widget failure verbatim at the provider-neutral tool seam. */
export function mapWidgetFailure(failure: WidgetFailure): DomainFailure {
  return {
    ok: false,
    errorCode: failure.errorCode,
    message: failure.message,
    retryable: failure.retryable,
    details: failure.details,
  };
}

/** Resolve a visible field name or current eNN ref to the core target shape. */
export async function resolveWidgetTarget(
  field: string,
  controller: AgentBrowserController,
): Promise<WidgetTarget | DomainFailure> {
  const observation = await controller.observe({
    cap: WIDGET_RESOLUTION_CAP,
    trackDigest: false,
  });
  const resolved = resolveFormField(field, observation);
  if (isDomainFailure(resolved)) return resolved;
  return {
    ref: resolved.ref,
    role: resolved.role,
    name: resolved.name,
    group: resolved.group ?? null,
    value: resolved.value ?? null,
  };
}

/** A literal opaque ref, as minted by `observe()`. */
const REF_PATTERN = /^e[0-9]+$/;

/** Identity a driver's target can be re-acquired by after a re-render. */
export interface WidgetTargetIdentity {
  /** The `field` string the caller supplied — a name, or an `eNN` ref. */
  readonly field: string;
  /** The target as first resolved, whose `ref` the driver holds. */
  readonly target: WidgetTarget;
}

/** True for the controller's typed stale-ref failure. */
export function isStaleRefError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'STALE_ELEMENT_REF'
  );
}

/**
 * Report a re-render that outlived re-acquisition, in the widget's own terms.
 *
 * The ref that went stale was minted by {@link resolveWidgetTarget}, not by the
 * model — very often the model passed a *name*. Surfacing `STALE_ELEMENT_REF`
 * there tells it to re-observe and use a fresh ref for an element it never saw,
 * which is advice it cannot act on and did not need.
 */
export function elementReplacedFailure(field: string, target: WidgetTarget): DomainFailure {
  return {
    ok: false,
    errorCode: 'WIDGET_ELEMENT_REPLACED',
    message:
      `The page replaced the "${target.name}" control while it was being operated, and it ` +
      'could not be found again. The widget may still be mid-update — retry the same call.',
    retryable: true,
    details: { field, name: target.name, role: target.role },
  };
}

/**
 * Queries to re-acquire the target by, strongest identity first.
 *
 * A trigger's accessible name frequently *changes* as the widget commits — a
 * date button reading `"Dates, Fri, Aug 21 - Sat, Aug 22"` becomes
 * `"Dates, Sun, Sep 6 - Sat, Sep 12"` — so the original full name is tried but
 * cannot be relied on. The caller's own `field` string is the durable identity
 * when it was a name, and the leading segment of the original name is the
 * fallback that survives the value changing.
 */
function reacquireQueries(field: string, target: WidgetTarget): readonly string[] {
  const queries: string[] = [];
  const trimmed = field.trim();
  if (trimmed.length > 0 && !REF_PATTERN.test(trimmed)) queries.push(trimmed);
  const name = target.name.trim();
  if (name.length > 0 && !queries.includes(name)) queries.push(name);
  const head = name.split(',')[0]?.trim() ?? '';
  if (head.length > 0 && !queries.includes(head)) queries.push(head);
  return queries;
}

/**
 * Adapt the controller to WidgetPort while recording primitive trace actions.
 *
 * When `identity` is supplied the port also heals the target's ref. Opening a
 * widget routinely causes the framework behind it to re-render the trigger, and
 * the driver is holding a ref to the node that got replaced — so every read
 * after the opening click throws. A driver cannot reasonably be written against
 * a page that stops existing underneath it, so the port re-acquires the element
 * and retries once, transparently.
 */
export function tracedWidgetPort(
  controller: AgentBrowserController,
  services: RunServices,
  identity?: WidgetTargetIdentity,
): WidgetPort {
  let currentRef = identity?.target.ref;
  const owns = (ref: string): boolean =>
    identity !== undefined && (ref === identity.target.ref || ref === currentRef);

  const reacquire = async (): Promise<boolean> => {
    if (identity === undefined) return false;
    const observation = await controller.observe({
      cap: WIDGET_RESOLUTION_CAP,
      trackDigest: false,
    });
    for (const query of reacquireQueries(identity.field, identity.target)) {
      const found = resolveFormField(query, observation);
      if (!isDomainFailure(found)) {
        currentRef = found.ref;
        return true;
      }
    }
    return false;
  };

  /** Run `operation` against the target's live ref, healing one replacement. */
  const healing = async <T>(ref: string, operation: (ref: string) => Promise<T>): Promise<T> => {
    const effective = owns(ref) && currentRef !== undefined ? currentRef : ref;
    try {
      return await operation(effective);
    } catch (error) {
      if (!isStaleRefError(error) || !owns(ref)) throw error;
      if (!(await reacquire())) throw error;
      return operation(currentRef!);
    }
  };

  return {
    observe: (options) => controller.observe(options),
    click: (requested) =>
      healing(requested, async (ref) => {
        const described = controller.describeRef(ref);
        const ranked = await safeLocatorFor(controller, ref);
        const result = await controller.click(ref);
        services.trace?.append({
          kind: 'click',
          host: controller.host(),
          locator:
            ranked.length > 0
              ? ranked
              : toCandidateChain(described?.role ?? 'button', described?.name ?? ''),
          requires_confirmation: false,
        });
        return result;
      }),
    fill: (requested, value) =>
      healing(requested, async (ref) => {
        const described = controller.describeRef(ref);
        const ranked = await safeLocatorFor(controller, ref);
        const result = await controller.fill(ref, value);
        services.trace?.append({
          kind: 'fill',
          host: controller.host(),
          locator:
            ranked.length > 0
              ? ranked
              : toCandidateChain(described?.role ?? 'textbox', described?.name ?? ''),
          value: { kind: 'literal', value: services.userInput?.mask(value) ?? value },
          submit: false,
          requires_confirmation: false,
        });
        return result;
      }),
    evaluateOn: (requested, fn, ...args) =>
      healing(requested, (ref) => controller.evaluateOn(ref, fn, ...args)),
    evaluate: controller.evaluate.bind(controller),
    press: (key) => controller.press(key),
    now: services.now,
  };
}
