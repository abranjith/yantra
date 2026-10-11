import { DEFAULT_HOST_OVERRIDES, type HostOverride } from './host-overrides.js';
import { redactText, UNSERIALIZABLE_PAYLOAD_MARKER, type TransformationTag } from './pipeline.js';
import { getProfile, type SanitizationProfile } from './profiles.js';
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

export type { TransformationTag } from './pipeline.js';
export {
  sanitizeStructured,
  type StructuredSanitizeOptions,
  type StructuredSanitizeResult,
} from './structured.js';

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
  const originalByteLength = Buffer.byteLength(coerced.text, 'utf8');

  // Preserved values are restored inside `redactText`, before truncation, so
  // the profile's byte cap applies to the text the model actually receives.
  let text = redactText(
    coerced.text,
    {
      profileDef,
      hostOverrides,
      ...(hostHint === undefined ? {} : { hostHint }),
      preserve: options?.preserve ?? [],
    },
    transformations,
  );

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
