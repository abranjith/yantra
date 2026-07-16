import { EthicsRefusedError } from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { browserController, isDomainFailure } from './browser-common.js';

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

/** Build the policy-checked single-page navigation tool. */
export function browserNavigateSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserNavigateParams> {
  return {
    name: 'browser_navigate',
    label: 'Browser Navigate',
    description:
      'Navigate the run-scoped browser page to an absolute URL. Use it before observing a page. Do NOT use it to bypass robots, blocks, host policy, or an intercepted popup policy.',
    parameters: BrowserNavigateParams,
    sanitizationProfile: 'public',
    mutating: true,
    run: (params: Params, ctx): Promise<DomainResult> => runNavigate(params, ctx.services),
  };
}

async function runNavigate(params: Params, services: RunServices): Promise<DomainResult> {
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
          message: 'Browser services are not configured.',
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
        message: `Navigation refused for ${allowed.value.host}: ${error.ethicsContext.reason}.`,
        retryable: false,
        details: { host: allowed.value.host, handoff: true },
      };
    }
    throw error;
  }
  const result = await controller.navigate(allowed.value.url);
  services.trace?.append({
    kind: 'navigate',
    host: allowed.value.host,
    url: allowed.value.url,
    requires_confirmation: false,
  });
  return { ok: true, model: result, details: { final_url: result.url } };
}
