/**
 * Personal profile + preferences (`~/.config/yantra/profile.yaml` + the merged
 * effective view). The privacy-gated personalization builder lives here too.
 */

export {
  KNOWN_PREFERENCE_KEYS,
  defaultProfile,
  flattenProfile,
  loadProfile,
  profilePath,
  profileSchema,
  saveProfile,
  validatePreference,
  type PreferenceKey,
  type ProfileFile,
} from './profile-file.js';
export {
  preferenceValue,
  type EffectivePreference,
  type EffectivePreferences,
  type PreferenceProvenance,
  type PreferenceSourceKind,
} from './effective-preferences.js';
export {
  MAX_LOCATION_CHARS,
  resolveAmbientGrants,
  resolveUserLocation,
  type AmbientGrants,
} from './ambient-context.js';
export {
  MAX_CONTEXT_CHARS,
  PersonalizationError,
  buildPersonalizationContext,
  type PersonalizationContext,
} from './personalization.js';
