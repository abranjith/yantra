import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { toCandidateChain } from '../../../runtime/trace.js';

import {
  browserController,
  browserFailure,
  followSiteOpenedTab,
  isDomainFailure,
  modelObservation,
  observeAfterAction,
  PROTECTED_ACTION_RE,
  recordActionProvenance,
  safeLocatorFor,
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
      'Click one actionable element by its latest opaque observation ref. A fresh post-action observation is returned, so browser_observe is only needed for a read without acting. Do NOT supply CSS/XPath, reuse stale refs, or click protected submit/purchase actions without user confirmation.',
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
      // Capture the element's role/name, durable locator, and host BEFORE
      // clicking — a click that navigates clears the refs along with the old
      // document, and the locator can only be derived from the live element.
      const described = controller.describeRef(params.ref);
      const host = controller.host();
      const name = described?.name ?? '';
      const ranked = await safeLocatorFor(controller, params.ref);
      try {
        const clicked = await controller.click(params.ref);
        // A click is how a page hands the run a new URL — by navigating, or by
        // opening a popup this policy closes and reports. Either way the page
        // produced it, so it is attested. Attesting BEFORE following the tab is
        // what lets the follow re-check it like any other navigation target.
        recordActionProvenance(ctx.services, clicked);
        const result = await followSiteOpenedTab(ctx.services, controller, clicked);
        ctx.services.trace?.append({
          kind: 'click',
          host,
          locator: ranked.length > 0 ? ranked : toCandidateChain(described?.role ?? '', name),
          requires_confirmation: PROTECTED_ACTION_RE.test(name),
        });
        const observation = await observeAfterAction(controller);
        // `popup_followable` is the handshake between the controller and the
        // policy check above; by now it is either followed or refused, and
        // showing the model a second copy of the URL it must not act on twice
        // is how a run ends up navigating away from the tab it just adopted.
        const { popup_followable: _followable, ...model } = result;
        return {
          ok: true,
          model: {
            ...model,
            ...(observation ? { observation: modelObservation(observation) } : {}),
          },
        };
      } catch (error) {
        return browserFailure(error);
      }
    },
  };
}
