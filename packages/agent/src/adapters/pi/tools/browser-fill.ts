import { assertHostBinding, withSecret } from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { toCandidateChain, type TraceFillValue } from '../../../runtime/trace.js';

import { browserController, browserFailure, isDomainFailure } from './browser-common.js';

const BrowserFillParams = Type.Object(
  {
    ref: Type.String({
      pattern: '^e[0-9]+$',
      description: 'Opaque textbox ref from the latest observation.',
    }),
    value: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('literal'),
          value: Type.String({ maxLength: 4096, description: 'Non-secret text to enter.' }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal('secret_ref'),
          key: Type.String({
            pattern: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$',
            description: 'Website secret key; host bindings come from trusted metadata.',
          }),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserFillParams>;

const SECRET_SHAPE =
  /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/;

/** Build the literal/host-bound secret fill tool. */
export function browserFillSpec(services: RunServices): ToolWrapperSpec<typeof BrowserFillParams> {
  return {
    name: 'browser_fill',
    label: 'Browser Fill',
    description:
      'Fill one observed field with a non-secret literal or trusted website secret reference. Use it only after observing the field. Do NOT put credentials in literals or supply host bindings yourself.',
    parameters: BrowserFillParams,
    sanitizationProfile: 'authenticated',
    mutating: true,
    requiresConfirmation: (params: Params) => params.value.kind === 'secret_ref',
    buildConfirmation: () => ({
      action_kind: 'fill',
      host: services.domain.browser?.controller.host() ?? '',
      description: 'Fill a protected website field using a host-bound secret.',
      consequence: 'reversible',
    }),
    run: (params: Params, ctx): Promise<DomainResult> => runFill(params, ctx.services),
  };
}

async function runFill(params: Params, services: RunServices): Promise<DomainResult> {
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
  // Capture role/name/host BEFORE the fill invalidates the observation. The
  // trace records a candidate chain and, for secrets, only the reference key.
  const described = controller.describeRef(params.ref);
  const host = controller.host();
  const recordTrace = (value: TraceFillValue): void =>
    services.trace?.append({
      kind: 'fill',
      host,
      locator: toCandidateChain(described?.role ?? '', described?.name ?? ''),
      value,
      submit: false,
      requires_confirmation: params.value.kind === 'secret_ref',
    });
  if (params.value.kind === 'literal') {
    if (SECRET_SHAPE.test(params.value.value))
      return {
        ok: false,
        errorCode: 'SECRET_SHAPED_LITERAL',
        message: 'Credential-shaped text must be supplied as a secret_ref, not a literal.',
        retryable: true,
      };
    try {
      const result = await controller.fill(params.ref, params.value.value);
      recordTrace({ kind: 'literal', value: params.value.value });
      return { ok: true, model: result };
    } catch (error) {
      return browserFailure(error);
    }
  }
  const resolver = deps.secretResolver;
  if (!resolver)
    return {
      ok: false,
      errorCode: 'SECRET_RESOLVER_UNAVAILABLE',
      message: 'Website secret resolution is unavailable.',
      retryable: false,
    };
  const hosts = await deps.secretHosts(params.value.key);
  try {
    assertHostBinding(
      { kind: 'secret', key: params.value.key, hosts: [...hosts] },
      controller.host(),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'SECRET_HOST_MISMATCH')
      return {
        ok: false,
        errorCode: 'SECRET_HOST_MISMATCH',
        message: error.message,
        retryable: false,
      };
    throw error;
  }
  const resolved = await resolver.resolve(
    { kind: 'secret', key: params.value.key },
    {
      taskParams: {},
      captures: {},
      stepId: 'browser_fill',
      taskId: services.runId,
      secretFieldExpected: true,
    },
  );
  try {
    const result = await withSecret(resolved.value, (value) => controller.fill(params.ref, value));
    recordTrace({ kind: 'secret_ref', key: params.value.key });
    return { ok: true, model: result, details: { secret_key: params.value.key } };
  } catch (error) {
    return browserFailure(error);
  } finally {
    resolved.dispose();
  }
}
