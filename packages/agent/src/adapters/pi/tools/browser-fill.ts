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
    value: Type.Union(
      [
        // The plain-string form is listed first and deliberately: it is the
        // shape models reach for, and small local models cannot reliably emit
        // the tagged-object variants (they loop on "value must be object"). A
        // bare string is always treated as a non-secret literal.
        Type.String({
          maxLength: 4096,
          description: 'Non-secret text to type. For a stored credential, use the secret_ref form.',
        }),
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
      ],
      {
        description:
          'Either a plain string to type, {"kind":"literal","value":"..."}, or ' +
          '{"kind":"secret_ref","key":"site.field"} for a stored credential.',
      },
    ),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserFillParams>;
type FillValue = Params['value'];

/** True when the fill value references a stored website secret (needs consent). */
function isSecretRef(value: FillValue): value is Extract<FillValue, { kind: 'secret_ref' }> {
  return typeof value === 'object' && value.kind === 'secret_ref';
}

/** The non-secret literal text to type, or null when the value is a secret_ref. */
function literalText(value: FillValue): string | null {
  if (typeof value === 'string') return value;
  return value.kind === 'literal' ? value.value : null;
}

const SECRET_SHAPE =
  /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/;

/** Build the literal/host-bound secret fill tool. */
export function browserFillSpec(services: RunServices): ToolWrapperSpec<typeof BrowserFillParams> {
  return {
    name: 'browser_fill',
    label: 'Browser Fill',
    description:
      'Fill one observed field. Pass "value" as a plain string for ordinary text, or as a secret_ref object for a stored credential. Use it only after observing the field. Do NOT put credentials in the plain-string/literal form or supply host bindings yourself.',
    parameters: BrowserFillParams,
    sanitizationProfile: 'authenticated',
    mutating: true,
    requiresConfirmation: (params: Params) => isSecretRef(params.value),
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
      requires_confirmation: value.kind === 'secret_ref',
    });
  // Plain string and {kind:'literal'} are the same thing: non-secret text the
  // model typed. Both flow through the credential-shape guard before filling.
  const literal = literalText(params.value);
  if (literal !== null) {
    if (SECRET_SHAPE.test(literal))
      return {
        ok: false,
        errorCode: 'SECRET_SHAPED_LITERAL',
        message: 'Credential-shaped text must be supplied as a secret_ref, not a literal.',
        retryable: true,
      };
    try {
      const result = await controller.fill(params.ref, literal);
      recordTrace({ kind: 'literal', value: literal });
      return { ok: true, model: result };
    } catch (error) {
      return browserFailure(error);
    }
  }
  // The literal branch returns above; a non-null-literal, non-secret value is
  // impossible for this closed union, so this narrows to the secret_ref variant.
  if (!isSecretRef(params.value))
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: 'A fill value must be text or a secret_ref.',
      retryable: true,
    };
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
