/**
 * The profile-driven redaction pass, shared by the text sanitizer
 * (`sanitize`) and the structural one (`sanitizeStructured`).
 *
 * Both entry points must apply the identical redactors in the identical order:
 * the structural sanitizer exists so the audit projection stays valid JSON, and
 * it is only safe if it never redacts less than the text path does. Keeping the
 * pass in one function is what makes that true by construction.
 */

import { matchHostOverride, normalizeHost, type HostOverride } from './host-overrides.js';
import type { ExtraRedactorTag } from './host-overrides.js';
import type { SanitizationProfileDef } from './profiles.js';
import {
  isStandalonePosition,
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
  stripAuthQueryParams,
  stripFormValues,
  stripQueryStrings,
  type TransformResult,
} from './strippers.js';

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

/** Stand-in text for a payload that cannot be serialized at all (cycles, bigint). */
export const UNSERIALIZABLE_PAYLOAD_MARKER = '[unserializable payload omitted]';

/** Context for one redaction pass. */
export interface RedactionContext {
  readonly profileDef: SanitizationProfileDef;
  readonly hostOverrides: readonly HostOverride[];
  readonly hostHint?: string;
  readonly preserve: readonly string[];
}

/**
 * Apply the profile's redactors (never its truncation) to one string.
 *
 * Tags are appended to `transformations` once per redactor that hit, so a
 * caller walking many leaves can collect them into one de-duplicated set.
 *
 * @param text Text to redact.
 * @param ctx Profile, host overrides, and values to preserve.
 * @param transformations Output collector for applied tags.
 * @returns The redacted text.
 */
export function redactText(
  text: string,
  ctx: RedactionContext,
  transformations: TransformationTag[],
): string {
  const { profileDef } = ctx;
  // Shield model-supplied values before any redactor runs, and restore them
  // after. Swapping them for sentinels no pattern can match is what makes the
  // preservation total: no redactor, host override, or future pattern can
  // partially consume a value the model already holds.
  const shield = shieldPreserved(text, ctx.preserve);
  let current = shield.text;

  if (!profileDef.bypassForLlmInput) {
    const formResult = profileDef.stripFormValues ? stripFormValues(current) : null;
    if (formResult !== null) {
      current = formResult.text;
      if (formResult.hits > 0) {
        transformations.push('form-value-strip');
      }
    }

    if (profileDef.stripAllQueryStrings) {
      current = applyStep(current, stripQueryStrings, 'query-all-strip', transformations);
    } else if (profileDef.stripAuthQueryParams) {
      current = applyStep(current, stripAuthQueryParams, 'query-auth-param-strip', transformations);
    }

    if (profileDef.redactPii.email) {
      current = applyStep(current, redactEmails, 'pii-email-redact', transformations);
    }
    if (profileDef.redactPii.ssn) {
      current = applyStep(current, redactSsn, 'pii-ssn-redact', transformations);
    }
    if (profileDef.redactPii.creditCard) {
      current = applyStep(current, redactCreditCards, 'pii-credit-card-redact', transformations);
    }
    if (profileDef.redactPii.phone) {
      current = applyStep(current, redactPhones, 'pii-phone-redact', transformations);
    }
    if (profileDef.redactPii.apiKeyShapes) {
      current = applyStep(current, redactApiKeyShapes, 'pii-apikey-redact', transformations);
    }

    if (profileDef.applyPerHostOverrides && ctx.hostHint) {
      const host = normalizeHost(ctx.hostHint);
      const override = matchHostOverride(host, ctx.hostOverrides);
      if (override) {
        for (const extraRedactor of override.extraRedactors) {
          const redactor = EXTRA_REDACTORS[extraRedactor];
          current = applyStep(current, redactor.run, redactor.tag, transformations);
        }
      }
    }
  }

  return shield.restore(current);
}

function applyStep(
  text: string,
  step: (text: string) => TransformResult,
  tag: TransformationTag,
  transformations: TransformationTag[],
): string {
  const result = step(text);
  if (result.hits > 0) {
    transformations.push(tag);
  }
  return result.text;
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
