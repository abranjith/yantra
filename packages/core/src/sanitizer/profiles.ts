import type { SecurityClass } from '@yantra/protocol';

import { SanitizationProfileError } from './errors.js';

export type SanitizationProfile = SecurityClass;

export interface SanitizationProfileDef {
  readonly name: SanitizationProfile;
  readonly stripFormValues: boolean;
  readonly stripAllQueryStrings: boolean;
  readonly stripAuthQueryParams: boolean;
  readonly redactPii: {
    readonly email: boolean;
    readonly ssn: boolean;
    readonly creditCard: boolean;
    readonly phone: boolean;
    readonly apiKeyShapes: boolean;
  };
  readonly applyPerHostOverrides: boolean;
  readonly truncateBytes: number;
  readonly bypassForLlmInput: boolean;
}

const DEFAULT_TRUNCATE_BYTES = 20_480;

const PROFILE_DEFINITIONS: Readonly<Record<SanitizationProfile, SanitizationProfileDef>> =
  Object.freeze({
    public: Object.freeze({
      name: 'public',
      stripFormValues: true,
      stripAllQueryStrings: false,
      stripAuthQueryParams: true,
      redactPii: Object.freeze({
        email: true,
        ssn: true,
        creditCard: true,
        phone: true,
        apiKeyShapes: true,
      }),
      applyPerHostOverrides: true,
      truncateBytes: DEFAULT_TRUNCATE_BYTES,
      bypassForLlmInput: false,
    }),
    'read-only-data': Object.freeze({
      name: 'read-only-data',
      stripFormValues: false,
      stripAllQueryStrings: false,
      stripAuthQueryParams: false,
      redactPii: Object.freeze({
        email: false,
        ssn: false,
        creditCard: false,
        phone: false,
        apiKeyShapes: false,
      }),
      applyPerHostOverrides: false,
      truncateBytes: DEFAULT_TRUNCATE_BYTES,
      bypassForLlmInput: true,
    }),
    authenticated: Object.freeze({
      name: 'authenticated',
      stripFormValues: true,
      stripAllQueryStrings: true,
      stripAuthQueryParams: true,
      redactPii: Object.freeze({
        email: true,
        ssn: true,
        creditCard: true,
        phone: true,
        apiKeyShapes: true,
      }),
      applyPerHostOverrides: true,
      truncateBytes: DEFAULT_TRUNCATE_BYTES,
      bypassForLlmInput: false,
    }),
  });

/**
 * Resolve a named sanitization profile.
 *
 * @param name Profile name from the protocol security class.
 * @returns Immutable profile definition.
 */
export function getProfile(name: string): SanitizationProfileDef {
  const profile = PROFILE_DEFINITIONS[name as SanitizationProfile];
  if (!profile) {
    throw new SanitizationProfileError(`Unknown sanitization profile: ${name}`, {
      profile: name,
    });
  }
  return profile;
}

export const SANITIZATION_PROFILES = PROFILE_DEFINITIONS;
