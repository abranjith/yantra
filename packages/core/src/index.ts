import { PROTOCOL_VERSION } from '@yantra/protocol';

export { PROTOCOL_VERSION };

export * from './browser/index.js';
export * from './locator/index.js';
export * from './executor/index.js';
export * from './ethics/index.js';
export * from './audit/index.js';
export * from './extraction/index.js';
export * from './synthesis/index.js';
export * from './research/index.js';
export * from './brief/index.js';
export * from './report-template/index.js';
export * from './index-db/index.js';
export * from './profile/index.js';
export * from './discovery/index.js';
export * from './scheduler/index.js';
export * from './ranking/index.js';
export * from './widgets/index.js';

export {
  DefaultSanitizer,
  ModelSuppliedValues,
  UserInputVault,
  UserInputMarkerError,
  MARKER_TAGS,
  brandSanitized,
  containsUserInputPlaceholder,
  containsHighRiskCredentialKeyword,
  detectKeywordValues,
  parseUserInputMarkers,
  redactRunInput,
  sanitize,
  type SanitizationProfile,
  type SanitizeOptions,
  type Sanitized,
  type SanitizedPayload,
  type Sanitizer as PayloadSanitizer,
  type TransformationTag,
  type AssignUserInputValue,
  type InputSegment,
  type RedactedRunInput,
  type UserInputMarkerErrorReason,
  type UserInputValueTag,
} from './sanitizer/index.js';

export {
  DefaultOpaqueRefResolver,
  DefaultScopeEnforcer,
  KeychainUnavailableError,
  SecretNotFoundError,
  ScopeViolationError as SecurityScopeViolationError,
  YANTRA_KEYCHAIN_SERVICE,
  buildScopeChain as buildSecurityScopeChain,
  createKeychainProvider,
  enforce as enforceSecurityScope,
  validateScopeViolations,
  assertHostBinding,
  SecretHostMismatchError,
  withSecret,
  type KeychainProvider,
  type OpaqueRefResolver,
  type ResolutionContext,
  type ResolvedValue as SecretResolvedValue,
} from './secrets/index.js';

export * from './workflow/recorder/index.js';
export * from './workflow/index.js';

export * from './scripts/index.js';

/** @deprecated Use PROTOCOL_VERSION directly. This re-export will be removed in a future release. */
export const CORE_PROTOCOL_VERSION = PROTOCOL_VERSION;
