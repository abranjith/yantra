import { Type } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import {
  browserController,
  browserFailure,
  isDomainFailure,
  modelObservation,
} from './browser-common.js';

const BrowserObserveParams = Type.Object({}, { additionalProperties: false });

/** Build the side-effect-free observation tool. */
export function browserObserveSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserObserveParams> {
  return {
    name: 'browser_observe',
    label: 'Browser Observe',
    description:
      'Read the current page without acting, as bounded sanitized text and opaque interactable refs. Action tools already return a fresh observation, so do not chain this after every action. Use it for an independent fresh read; never invent refs or reuse them after navigation.',
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
        return { ok: true, model: modelObservation(observation) };
      } catch (error) {
        return browserFailure(error);
      }
    },
  };
}
