import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { toCandidateChain } from '../../../runtime/trace.js';

import {
  browserController,
  browserFailure,
  isDomainFailure,
  PROTECTED_ACTION_RE,
} from './browser-common.js';

const BrowserClickParams = Type.Object(
  {
    ref: Type.String({
      pattern: '^e[0-9]+$',
      description: 'Opaque ref from the latest browser_observe result.',
    }),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserClickParams>;

/** Build the opaque-ref click tool with protected-action confirmation. */
export function browserClickSpec(
  services: RunServices,
): ToolWrapperSpec<typeof BrowserClickParams> {
  return {
    name: 'browser_click',
    label: 'Browser Click',
    description:
      'Click one actionable element by its latest opaque observation ref. Use it after browser_observe. Do NOT supply CSS/XPath, reuse stale refs, or click protected submit/purchase actions without user confirmation.',
    parameters: BrowserClickParams,
    sanitizationProfile: 'public',
    mutating: true,
    requiresConfirmation: (params: Params) =>
      PROTECTED_ACTION_RE.test(
        services.domain.browser?.controller.describeRef(params.ref)?.name ?? '',
      ),
    buildConfirmation: (params: Params) => ({
      action_kind: 'click',
      host: services.domain.browser?.controller.host() ?? '',
      description: `Click "${services.domain.browser?.controller.describeRef(params.ref)?.name ?? params.ref}".`,
      consequence: 'hard_to_reverse',
    }),
    run: async (params: Params, ctx): Promise<DomainResult> => {
      const controller = browserController(ctx.services);
      if (isDomainFailure(controller)) return controller;
      // Capture the element's role/name and host BEFORE clicking — the click
      // invalidates the observation (refs are cleared) and may navigate away.
      const described = controller.describeRef(params.ref);
      const host = controller.host();
      const name = described?.name ?? '';
      try {
        const result = await controller.click(params.ref);
        ctx.services.trace?.append({
          kind: 'click',
          host,
          locator: toCandidateChain(described?.role ?? '', name),
          requires_confirmation: PROTECTED_ACTION_RE.test(name),
        });
        return { ok: true, model: result };
      } catch (error) {
        return browserFailure(error);
      }
    },
  };
}
