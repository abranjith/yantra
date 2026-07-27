import { Type } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { browserController, browserFailure, isDomainFailure } from './browser-common.js';

const BrowserObserveParams = Type.Object({}, { additionalProperties: false });

/** Build the side-effect-free observation tool. */
export function browserObserveSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserObserveParams> {
  return {
    name: 'browser_observe',
    label: 'Browser Observe',
    description:
      'Observe the current page as bounded sanitized text and opaque interactable refs. Use it after navigating and to verify changes; refs stay valid across actions on the same page. Do NOT invent refs or reuse them after a navigation.',
    parameters: BrowserObserveParams,
    sanitizationProfile: 'public',
    run: async (_params, ctx): Promise<DomainResult> => {
      const controller = browserController(ctx.services);
      if (isDomainFailure(controller)) return controller;
      try {
        const observation = await controller.observe();
        // Recorded so promotion can tell that this run *ended* by reading the
        // page. A run whose last act is an observation has collected its answer
        // from the digest and never calls `browser_extract`; without this the
        // promoted workflow clicks through and captures nothing.
        ctx.services.trace?.append({
          kind: 'observe',
          host: controller.host(),
          requires_confirmation: false,
        });
        return { ok: true, model: observation };
      } catch (error) {
        return browserFailure(error);
      }
    },
  };
}
