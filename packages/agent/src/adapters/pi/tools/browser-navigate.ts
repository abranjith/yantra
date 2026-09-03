import { EthicsRefusedError } from '@yantra/core';
import { Type, type Static } from 'typebox';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import {
  browserController,
  deltaDetails,
  isDomainFailure,
  modelDelta,
  modelObservation,
  observeAfterAction,
  recordActionProvenance,
} from './browser-common.js';

const BrowserNavigateParams = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: 2048,
      description: 'Absolute policy-approved URL to open.',
    }),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserNavigateParams>;

const refusalCounts = new WeakMap<RunServices, Map<string, number>>();

/** Build the policy-checked single-page navigation tool. */
export function browserNavigateSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserNavigateParams> {
  return {
    name: 'browser_navigate',
    label: 'Browser Navigate',
    description:
      'Navigate the run-scoped browser page to an absolute URL and return a fresh observation. It also returns delta: what changed between the page you last saw and this one — URL, dialogs opened or closed, how many elements appeared or vanished, where focus went — which describes the action window rather than claiming the navigation caused every change, and says complete: false with a reason wherever a bound stopped it being definite; a navigation to a new document reports document-replaced and no element counts, because a new page’s controls are not the old page’s. browser_observe is only needed for a read without acting. When an action reports popup_intercepted, that URL is where the site was sending you: navigate to it to continue. Do NOT use it to bypass robots, blocks, or host policy.',
    parameters: BrowserNavigateParams,
    sanitizationProfile: 'public',
    mutating: true,
    run: (params: Params, ctx): Promise<DomainResult> => runNavigate(params, ctx.services),
  };
}

async function runNavigate(params: Params, services: RunServices): Promise<DomainResult> {
  // Provenance is checked BEFORE the URL policy: `check` reserves navigation
  // and host budget, and a refused guess must not consume the budget a
  // legitimate navigation still needs.
  if (!services.urlProvenance.has(params.url)) {
    const count = recordRefusal(services, params.url);
    return {
      ok: false,
      errorCode: 'URL_NOT_FROM_EVIDENCE',
      retryable: true,
      message: renderAgentMessage('tool', 'URL_NOT_FROM_EVIDENCE', 'unattested-url', {
        repeated: count >= 2,
      }),
    };
  }
  const allowed = services.urlPolicy.check(params.url);
  if (!allowed.isOk)
    return {
      ok: false,
      errorCode: allowed.error.code,
      message: allowed.error.message,
      retryable: allowed.error.retryable,
    };
  const deps = services.domain.browser;
  const controller = browserController(services);
  if (!deps || isDomainFailure(controller))
    return isDomainFailure(controller)
      ? controller
      : {
          ok: false,
          errorCode: 'BROWSER_UNAVAILABLE',
          message: renderAgentMessage('tool', 'BROWSER_UNAVAILABLE', 'services-missing'),
          retryable: false,
        };
  try {
    await deps.ethics.check(allowed.value.url, 'navigate', {
      taskId: services.runId,
      runId: services.runId,
      stepId: 'browser_navigate',
    });
  } catch (error) {
    if (error instanceof EthicsRefusedError) {
      return {
        ok: false,
        errorCode: 'ETHICS_BLOCKED',
        message: renderAgentMessage('tool', 'ETHICS_BLOCKED', 'navigation-refused', {
          host: allowed.value.host,
          reason: error.ethicsContext.reason,
        }),
        retryable: false,
        details: { host: allowed.value.host, handoff: true },
      };
    }
    throw error;
  }
  const result = await controller.navigate(allowed.value.url);
  recordActionProvenance(services, result);
  services.trace?.append({
    kind: 'navigate',
    host: allowed.value.host,
    url: allowed.value.url,
    requires_confirmation: false,
  });
  const { observation, delta } = await observeAfterAction(controller);
  // Internal handshake between the controller and the tab-follow policy check
  // in browser_click; never part of what the model reads. See
  // `followSiteOpenedTab`.
  const { popup_followable: _followable, ...model } = result;
  return {
    ok: true,
    model: {
      ...model,
      ...(observation ? { observation: modelObservation(observation) } : {}),
      ...(delta ? { delta: modelDelta(delta) } : {}),
    },
    details: { final_url: result.url, ...deltaDetails(observation, delta) },
  };
}

function recordRefusal(services: RunServices, value: string): number {
  let perRun = refusalCounts.get(services);
  if (!perRun) {
    perRun = new Map();
    refusalCounts.set(services, perRun);
  }
  const normalized = normalizeRefusedUrl(value);
  const count = (perRun.get(normalized) ?? 0) + 1;
  perRun.set(normalized, count);
  return count;
}

function normalizeRefusedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim();
  }
}
