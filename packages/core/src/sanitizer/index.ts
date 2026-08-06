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
  redactVin,
  isStandalonePosition,
  stripAuthQueryParams,
  stripFormValues,
  stripQueryStrings,
  type TransformResult,
} from './strippers.js';
import { truncateUtf8 } from './truncate.js';
import { containsHighRiskCredentialKeyword } from './user-input-keywords.js';
import { parseUserInputMarkers } from './user-input-markers.js';
import { UserInputVault } from './user-input.js';

export type { SanitizationProfile } from './profiles.js';
export { brandSanitized, type Sanitized } from './brand.js';
export { ModelSuppliedValues } from './model-values.js';
export {
  UserInputVault,
  containsUserInputPlaceholder,
  type UserInputValueTag,
} from './user-input.js';
export {
  MARKER_TAGS,
  UserInputMarkerError,
  containsUserInputPlaceholder as containsReservedUserInputPlaceholder,
  parseUserInputMarkers,
  type AssignUserInputValue,
  type InputSegment,
  type UserInputMarkerErrorReason,
} from './user-input-markers.js';
export { containsHighRiskCredentialKeyword, detectKeywordValues } from './user-input-keywords.js';

/** Result of the one ingress redaction pass for an agentic run. */
export interface RedactedRunInput {
  readonly goal: string;
  readonly profileContext?: string;
  readonly vault: UserInputVault;
  readonly warnings: readonly string[];
}

/**
 * Redact all user-authored agent input exactly once before run creation.
 *
 * The returned vault must travel with the run so tool middleware can resolve
 * placeholders and re-mask echoes. Warnings are advisory and contain no raw
 * marked values.
 */
export function redactRunInput(input: {
  readonly goal: string;
  readonly profileContext?: string;
}): RedactedRunInput {
  const parsedGoal = parseUserInputMarkers(input.goal);
  const goalHasMarker = parsedGoal.some((segment) => segment.kind === 'value');
  const vault = new UserInputVault();
  const goal = vault.redact(input.goal);
  const profileContext =
    input.profileContext === undefined ? undefined : vault.redact(input.profileContext);
  const warnings = [
    ...(!goalHasMarker && containsHighRiskCredentialKeyword(input.goal)
      ? [
          'Sensitive credential wording was detected without an explicit marker; use `@{...}` (or a tagged form such as `@password{...}`) to guarantee the value stays out of the model.',
        ]
      : []),
    ...vault.warnOnShortValues(),
  ];
  return {
    goal,
    ...(profileContext === undefined ? {} : { profileContext }),
    vault,
    warnings,
  };
}

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
  | 'host-override-vin'
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
  vin: { run: redactVin, tag: 'host-override-vin' },
});

export interface SanitizedPayload {
  readonly text: string;
  readonly profile: SanitizationProfile;
  readonly transformationsApplied: readonly TransformationTag[];
  readonly truncated: boolean;
  readonly originalByteLength: number;
}

/** Optional per-call controls layered on top of the profile. */
export interface SanitizeOptions {
  /**
   * Values that must survive redaction verbatim: strings the model itself
   * supplied this run (see `ModelSuppliedValues`). Redacting a value already in
   * the model's context protects nothing and breaks its ability to verify its
   * own actions, so these are shielded from the shape-based redactors and
   * restored before truncation.
   */
  readonly preserve?: readonly string[];
}

export interface Sanitizer {
  sanitize(
    payload: unknown,
    profile: SanitizationProfile,
    hostHint?: string,
    options?: SanitizeOptions,
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
    options?: SanitizeOptions,
  ): SanitizedPayload {
    return sanitizeWithOverrides(payload, profile, this.hostOverrides, hostHint, options);
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
  options?: SanitizeOptions,
): SanitizedPayload {
  return sanitizeWithOverrides(payload, profile, DEFAULT_HOST_OVERRIDES, hostHint, options);
}

function sanitizeWithOverrides(
  payload: unknown,
  profile: SanitizationProfile,
  hostOverrides: readonly HostOverride[],
  hostHint?: string,
  options?: SanitizeOptions,
): SanitizedPayload {
  const profileDef = getProfile(profile);
  const transformations: TransformationTag[] = [];

  const coerced = coercePayload(payload);
  let text = coerced.text;
  const originalByteLength = Buffer.byteLength(text, 'utf8');

  // Shield model-supplied values before any redactor runs, and restore them
  // after. Swapping them for sentinels no pattern can match is what makes the
  // preservation total: no redactor, host override, or future pattern can
  // partially consume a value the model already holds.
  const shield = shieldPreserved(text, options?.preserve ?? []);
  text = shield.text;

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

  // Restore before truncation so the profile's byte cap applies to the text the
  // model actually receives.
  text = shield.restore(text);

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

/**
 * Sentinel wrapper for shielded values. Constraints, all of them load-bearing:
 *
 * - **URL-safe unreserved ASCII.** `stripAuthQueryParams` round-trips URLs
 *   through `new URL().toString()`, which percent-encodes anything else — a
 *   non-ASCII sentinel came back as `%EE%80%80` and could no longer be restored.
 * - **Lowercase letters around the index.** Keeps the sentinel clear of every
 *   redactor pattern, including the uppercase-anchored IBAN and case-number
 *   shapes and the digit-run phone/card shapes.
 * - **Distinctive enough never to occur in real content.**
 */
const SHIELD_MARK = 'yantrakeep';

interface Shield {
  readonly text: string;
  readonly restore: (text: string) => string;
}

/**
 * Replace each preserved value with an inert sentinel, returning the shielded
 * text plus the inverse operation.
 *
 * @param text Coerced payload text.
 * @param preserve Values to shield, longest first (the caller's ordering is
 *   honored so a short value nested in a longer one cannot claim it first).
 */
function shieldPreserved(text: string, preserve: readonly string[]): Shield {
  if (preserve.length === 0) return { text, restore: (value) => value };
  const restorations: { readonly sentinel: string; readonly value: string }[] = [];
  let shielded = text;
  for (const value of preserve) {
    if (value.length === 0 || !shielded.includes(value)) continue;
    const sentinel = `${SHIELD_MARK}${restorations.length}${SHIELD_MARK}`;
    const next = shieldStandaloneOccurrences(shielded, value, sentinel);
    if (next === shielded) continue;
    shielded = next;
    restorations.push({ sentinel, value });
  }
  if (restorations.length === 0) return { text, restore: (value) => value };
  return {
    text: shielded,
    restore: (value) => {
      let restored = value;
      for (const entry of restorations) {
        restored = restored.split(entry.sentinel).join(entry.value);
      }
      return restored;
    },
  };
}

/**
 * Replace only the STANDALONE occurrences of a preserved value.
 *
 * A preserved value sitting inside a longer number belongs to that number, not
 * to the model: shielding it there would break the run of digits a redactor
 * needs to match and leak the surrounding value. Requiring a token boundary
 * keeps preservation from ever weakening redaction of data the model does not
 * already hold.
 */
function shieldStandaloneOccurrences(text: string, value: string, sentinel: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const found = text.indexOf(value, cursor);
    if (found === -1) return out + text.slice(cursor);
    out += text.slice(cursor, found);
    out += isStandalonePosition(text, found, value.length) ? sentinel : value;
    cursor = found + value.length;
  }
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
