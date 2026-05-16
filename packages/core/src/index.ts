import { PROTOCOL_VERSION } from '@yantra/protocol';

export { PROTOCOL_VERSION };

export * from './browser/index.js';
export * from './locator/index.js';
export * from './executor/index.js';
export * from './ethics/index.js';
export * from './audit/index.js';
export * from './extraction/index.js';

export {
	DefaultSanitizer,
	sanitize,
	type SanitizationProfile,
	type SanitizedPayload,
	type Sanitizer as PayloadSanitizer,
	type TransformationTag,
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
	withSecret,
	type KeychainProvider,
	type OpaqueRefResolver,
	type ResolutionContext,
	type ResolvedValue as SecretResolvedValue,
} from './secrets/index.js';

export * from './workflow/recorder/index.js';

/** @deprecated Use PROTOCOL_VERSION directly. This re-export will be removed in a future release. */
export const CORE_PROTOCOL_VERSION = PROTOCOL_VERSION;
