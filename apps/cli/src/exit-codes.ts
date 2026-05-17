/**
 * Centralized exit-code map for the Yantra CLI.
 *
 * Per `.spec-lite/plan.md` §5 the contract is:
 *
 * - 0: success
 * - 1: validation error (bad YAML, missing flag)
 * - 2: execution failure (run started, ended in failure)
 * - 3: environment failure (`yantra doctor` would fail; includes "not initialized")
 * - 4: user-handoff abort (CAPTCHA, MFA, consent-required resume)
 *
 * Every CLI handler returns a {@link CommandOutcome}; `main` maps it to the
 * corresponding numeric exit code via {@link exitCodeFor}.
 */

export const EXIT = {
  OK: 0,
  VALIDATION: 1,
  EXECUTION_FAILURE: 2,
  ENVIRONMENT_FAILURE: 3,
  USER_HANDOFF: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type CommandOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'validation_error'; readonly message: string }
  | {
      readonly kind: 'execution_failure';
      readonly message: string;
      readonly reportPath?: string;
    }
  | {
      readonly kind: 'environment_failure';
      readonly message: string;
      readonly remediation?: string;
    }
  | { readonly kind: 'user_handoff_abort'; readonly reason: string };

export function exitCodeFor(outcome: CommandOutcome): ExitCode {
  switch (outcome.kind) {
    case 'ok':
      return EXIT.OK;
    case 'validation_error':
      return EXIT.VALIDATION;
    case 'execution_failure':
      return EXIT.EXECUTION_FAILURE;
    case 'environment_failure':
      return EXIT.ENVIRONMENT_FAILURE;
    case 'user_handoff_abort':
      return EXIT.USER_HANDOFF;
  }
}
