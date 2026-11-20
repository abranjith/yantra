/**
 * In-memory-only flag recording that the user clicked "Not now" during the
 * current page session. Never persisted to `profile.yaml` or web storage
 * (FEAT-071 SD-2).
 */
let dismissed = false;

export function isOnboardingDismissed(): boolean {
  return dismissed;
}

export function dismissOnboarding(): void {
  dismissed = true;
}

export function resetOnboardingDismissal(): void {
  dismissed = false;
}
