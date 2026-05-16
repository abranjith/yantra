import {
  DEFAULT_HOST_OVERRIDES,
  matchHostOverride,
  normalizeHost,
  type HostOverride,
} from './host-overrides.js';
import { getProfile, type SanitizationProfile } from './profiles.js';
import {
  redactApiKeyShapes,
  redactCaseNumber,
  redactCreditCards,
  redactCurrencyUsd,
  redactDateOfBirth,
  redactEmails,
  redactPhones,
  redactSsn,
  stripAuthQueryParams,
  stripFormValues,
  stripQueryStrings,
} from './strippers.js';
import { truncateUtf8 } from './truncate.js';

export type { SanitizationProfile } from './profiles.js';

export type TransformationTag =
  | 'form-value-strip'
  | 'query-all-strip'
  | 'query-auth-param-strip'
  | 'pii-email-redact'
  | 'pii-ssn-redact'
  | 'pii-credit-card-redact'
  | 'pii-phone-redact'
  | 'pii-apikey-redact'
  | 'host-override-currency-usd'
  | 'host-override-date-of-birth'
  | 'host-override-case-number'
  | 'truncate';

export interface SanitizedPayload {
  readonly text: string;
  readonly profile: SanitizationProfile;
  readonly transformationsApplied: readonly TransformationTag[];
  readonly truncated: boolean;
  readonly originalByteLength: number;
}

export interface Sanitizer {
  sanitize(
    payload: unknown,
    profile: SanitizationProfile,
    hostHint?: string,
  ): SanitizedPayload;
}

interface CoercedPayload {
  readonly text: string;
  readonly coercionFailed: boolean;
}

const UNSERIALIZABLE_PAYLOAD_MARKER = '[unserializable payload omitted]';

/**
 * Default sanitizer implementation with in-memory host override matching.
 */
export class DefaultSanitizer implements Sanitizer {
  public constructor(
    private readonly hostOverrides: readonly HostOverride[] = DEFAULT_HOST_OVERRIDES,
  ) {}

  public sanitize(
    payload: unknown,
    profile: SanitizationProfile,
    hostHint?: string,
  ): SanitizedPayload {
    return sanitizeWithOverrides(payload, profile, this.hostOverrides, hostHint);
  }
}

/**
 * The single LLM-bound sanitizer chokepoint.
 *
 * @param payload Arbitrary value to sanitize.
 * @param profile Sanitization profile derived from security class.
 * @param hostHint Optional host name or URL used for per-host overrides.
 */
export function sanitize(
  payload: unknown,
  profile: SanitizationProfile,
  hostHint?: string,
): SanitizedPayload {
  return sanitizeWithOverrides(payload, profile, DEFAULT_HOST_OVERRIDES, hostHint);
}

function sanitizeWithOverrides(
  payload: unknown,
  profile: SanitizationProfile,
  hostOverrides: readonly HostOverride[],
  hostHint?: string,
): SanitizedPayload {
  const profileDef = getProfile(profile);
  const transformations: TransformationTag[] = [];

  const coerced = coercePayload(payload);
  let text = coerced.text;
  const originalByteLength = Buffer.byteLength(text, 'utf8');

  if (!profileDef.bypassForLlmInput) {
    const formResult = profileDef.stripFormValues ? stripFormValues(text) : null;
    if (formResult !== null) {
      text = formResult.text;
      if (formResult.hits > 0) {
        transformations.push('form-value-strip');
      }
    }

    if (profileDef.stripAllQueryStrings) {
      const queryResult = stripQueryStrings(text);
      text = queryResult.text;
      if (queryResult.hits > 0) {
        transformations.push('query-all-strip');
      }
    } else if (profileDef.stripAuthQueryParams) {
      const authQueryResult = stripAuthQueryParams(text);
      text = authQueryResult.text;
      if (authQueryResult.hits > 0) {
        transformations.push('query-auth-param-strip');
      }
    }

    if (profileDef.redactPii.email) {
      const result = redactEmails(text);
      text = result.text;
      if (result.hits > 0) {
        transformations.push('pii-email-redact');
      }
    }

    if (profileDef.redactPii.ssn) {
      const result = redactSsn(text);
      text = result.text;
      if (result.hits > 0) {
        transformations.push('pii-ssn-redact');
      }
    }

    if (profileDef.redactPii.creditCard) {
      const result = redactCreditCards(text);
      text = result.text;
      if (result.hits > 0) {
        transformations.push('pii-credit-card-redact');
      }
    }

    if (profileDef.redactPii.phone) {
      const result = redactPhones(text);
      text = result.text;
      if (result.hits > 0) {
        transformations.push('pii-phone-redact');
      }
    }

    if (profileDef.redactPii.apiKeyShapes) {
      const result = redactApiKeyShapes(text);
      text = result.text;
      if (result.hits > 0) {
        transformations.push('pii-apikey-redact');
      }
    }

    if (profileDef.applyPerHostOverrides && hostHint) {
      const host = normalizeHost(hostHint);
      const override = matchHostOverride(host, hostOverrides);
      if (override) {
        for (const extraRedactor of override.extraRedactors) {
          if (extraRedactor === 'currency_usd') {
            const result = redactCurrencyUsd(text);
            text = result.text;
            if (result.hits > 0) {
              transformations.push('host-override-currency-usd');
            }
          }

          if (extraRedactor === 'date_of_birth') {
            const result = redactDateOfBirth(text);
            text = result.text;
            if (result.hits > 0) {
              transformations.push('host-override-date-of-birth');
            }
          }

          if (extraRedactor === 'case_number') {
            const result = redactCaseNumber(text);
            text = result.text;
            if (result.hits > 0) {
              transformations.push('host-override-case-number');
            }
          }
        }
      }
    }
  }

  const truncatedResult = truncateUtf8(text, profileDef.truncateBytes);
  text = truncatedResult.text;

  if (truncatedResult.truncated || coerced.coercionFailed) {
    transformations.push('truncate');
  }

  return {
    text,
    profile: profileDef.name,
    transformationsApplied: transformations,
    truncated: truncatedResult.truncated,
    originalByteLength,
  };
}

function coercePayload(payload: unknown): CoercedPayload {
  if (typeof payload === 'string') {
    return { text: payload, coercionFailed: false };
  }

  try {
    const serialized = JSON.stringify(payload);
    if (serialized !== undefined) {
      return { text: serialized, coercionFailed: false };
    }
  } catch {
    return { text: UNSERIALIZABLE_PAYLOAD_MARKER, coercionFailed: true };
  }

  return {
    text: String(payload),
    coercionFailed: false,
  };
}
