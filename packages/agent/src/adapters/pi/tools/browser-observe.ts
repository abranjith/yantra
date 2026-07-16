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
      'Observe the current page as bounded sanitized text and opaque interactable refs. Use it before each action and again to verify changes. Do NOT invent or reuse refs from older observations.',
    parameters: BrowserObserveParams,
    sanitizationProfile: 'public',
    run: async (_params, ctx): Promise<DomainResult> => {
      const controller = browserController(ctx.services);
      if (isDomainFailure(controller)) return controller;
      try {
        return { ok: true, model: await controller.observe() };
      } catch (error) {
        return browserFailure(error);
      }
    },
  };
}
