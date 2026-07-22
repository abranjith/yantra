import {
  DEFAULT_HOST_OVERRIDES,
  matchHostOverride,
  normalizeHost,
  type HostOverride,
} from './host-overrides.js';
import type { ExtraRedactorTag } from './host-overrides.js';
import { getProfile, type SanitizationProfile } from './profiles.js';
import {
  redactAccountNumber,
  redactApiKeyShapes,
  redactCaseNumber,
  redactCreditCards,
  redactCurrencyUsd,
  redactDateOfBirth,
  redactDriversLicense,
  redactEmails,
  redactIban,
  redactMedicalRecordNumber,
  redactMemberId,
  redactPassportNumber,
  redactPhones,
  redactSsn,
  redactTaxId,
  stripAuthQueryParams,
  stripFormValues,
  stripQueryStrings,
  type TransformResult,
} from './strippers.js';
import { truncateUtf8 } from './truncate.js';

export type { SanitizationProfile } from './profiles.js';
export { brandSanitized, type Sanitized } from './brand.js';
export {
  UserInputVault,
  containsUserInputPlaceholder,
  type UserInputValueTag,
} from './user-input.js';

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
  | 'host-override-account-number'
  | 'host-override-iban'
  | 'host-override-member-id'
  | 'host-override-medical-record-number'
  | 'host-override-tax-id'
  | 'host-override-passport-number'
  | 'host-override-drivers-license'
  | 'truncate';

/** Per-host extra redactors, keyed by their config tag (single dispatch table). */
const EXTRA_REDACTORS: Readonly<
  Record<
    ExtraRedactorTag,
    { readonly run: (text: string) => TransformResult; readonly tag: TransformationTag }
  >
> = Object.freeze({
  currency_usd: { run: redactCurrencyUsd, tag: 'host-override-currency-usd' },
  date_of_birth: { run: redactDateOfBirth, tag: 'host-override-date-of-birth' },
  case_number: { run: redactCaseNumber, tag: 'host-override-case-number' },
  account_number: { run: redactAccountNumber, tag: 'host-override-account-number' },
  iban: { run: redactIban, tag: 'host-override-iban' },
  member_id: { run: redactMemberId, tag: 'host-override-member-id' },
  medical_record_number: {
    run: redactMedicalRecordNumber,
    tag: 'host-override-medical-record-number',
  },
  tax_id: { run: redactTaxId, tag: 'host-override-tax-id' },
  passport_number: { run: redactPassportNumber, tag: 'host-override-passport-number' },
  drivers_license: { run: redactDriversLicense, tag: 'host-override-drivers-license' },
});

export interface SanitizedPayload {
  readonly text: string;
  readonly profile: SanitizationProfile;
  readonly transformationsApplied: readonly TransformationTag[];
  readonly truncated: boolean;
  readonly originalByteLength: number;
}

export interface Sanitizer {
  sanitize(payload: unknown, profile: SanitizationProfile, hostHint?: string): SanitizedPayload;
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
          const redactor = EXTRA_REDACTORS[extraRedactor];
          const result = redactor.run(text);
          text = result.text;
          if (result.hits > 0) {
            transformations.push(redactor.tag);
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
