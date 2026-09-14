/** Custom error classes for the browser module. Each carries structured context. */

import type {
  BrowserResolutionErrorCode,
  BrowserSelection,
  CapabilityEvidence,
  ProbeFailureClass,
  ProbeProfile,
} from './installation-types.js';
import type { ManagedInstallError } from './managed-install-types.js';

/**
 * Resolution refused to hand back an installation.
 *
 * Compatibility and process failures have their own types rather than
 * collapsing in here: an explicit selection that exists but cannot run must
 * not be reported as a missing browser, because the two have different repairs.
 */
export class BrowserResolutionError extends Error {
  override readonly name = 'BrowserResolutionError';

  readonly code: BrowserResolutionErrorCode;
  readonly requestedSelection: BrowserSelection;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly remediation: string;

  constructor(context: {
    readonly code: BrowserResolutionErrorCode;
    readonly message: string;
    readonly requestedSelection: BrowserSelection;
    readonly evidence?: Readonly<Record<string, unknown>>;
    readonly remediation: string;
  }) {
    super(`${context.message} ${context.remediation}`.trim());
    this.code = context.code;
    this.requestedSelection = context.requestedSelection;
    this.evidence = Object.freeze({ ...(context.evidence ?? {}) });
    this.remediation = context.remediation;
  }
}

/** A local compatibility probe refused the executable. Environment exit 3. */
export class BrowserCompatibilityError extends Error {
  override readonly name = 'BrowserCompatibilityError';

  constructor(
    readonly context: {
      readonly failureClass: ProbeFailureClass;
      readonly profile: ProbeProfile;
      readonly executablePath: string;
      readonly version: string;
      readonly capabilities: readonly CapabilityEvidence[];
      readonly remediation: string;
    },
  ) {
    const failed = context.capabilities
      .filter((c) => c.status === 'failed')
      .map((c) => c.capability);
    const named = failed.length > 0 ? ` Failed: ${failed.join(', ')}.` : '';
    super(
      `Chrome ${context.version} failed the ${context.profile} compatibility check (${context.failureClass}).${named} ${context.remediation}`.trim(),
    );
  }
}

/** A human declined or timed out the one interactive managed-browser offer. */
export class BrowserInstallOfferDeclinedError extends Error {
  override readonly name = 'BrowserInstallOfferDeclinedError';
  readonly exitCode = 4;

  constructor() {
    super(
      'No browser is available. Run `yantra browser install` when you are ready to download one.',
    );
  }
}

/** A consented interactive managed install failed before the task could resume. */
export class BrowserManagedInstallError extends Error {
  override readonly name = 'BrowserManagedInstallError';
  readonly exitCode = 3;

  constructor(readonly installError: ManagedInstallError) {
    super(`${installError.detail} ${installError.remediation}`.trim());
  }
}

/** Managed coordination refused a claim, or could not prove it is safe. */
export class ManagedCoordinationError extends Error {
  override readonly name = 'ManagedCoordinationError';

  constructor(
    readonly context: {
      readonly reason:
        | 'operation-in-progress'
        | 'active-use'
        | 'uncertain-owner'
        | 'ready-changed'
        | 'lost-ownership'
        | 'invalid-permit';
      readonly detail: string;
      readonly remediation: string;
    },
  ) {
    super(`${context.detail} ${context.remediation}`.trim());
  }
}

/** Startup or shutdown could not account for the browser process. */
export class BrowserProcessError extends Error {
  override readonly name = 'BrowserProcessError';

  constructor(
    readonly context: {
      readonly phase: 'spawn' | 'settle' | 'close' | 'cleanup';
      readonly detail: string;
      /** False when Yantra cannot prove the process tree exited. */
      readonly exitProven: boolean;
    },
  ) {
    super(`Browser process ${context.phase} failed: ${context.detail}`);
  }
}

export class ChromeNotFoundError extends Error {
  override readonly name = 'ChromeNotFoundError';

  constructor(readonly context: { readonly os: string; readonly probed: readonly string[] }) {
    super(`Chrome not found on ${context.os}. Probed: ${context.probed.join(', ')}`);
  }
}

export class ChromeVersionUnsupportedError extends Error {
  override readonly name = 'ChromeVersionUnsupportedError';

  constructor(readonly context: { readonly found: number; readonly required: number }) {
    super(
      `Chrome version ${context.found} is below the minimum required version ${context.required}. Please update Chrome.`,
    );
  }
}

export class BrowserLaunchError extends Error {
  override readonly name = 'BrowserLaunchError';

  constructor(
    readonly context: {
      readonly phase: 'spawn' | 'connect' | 'timeout';
      readonly lastStderr: string;
      readonly args: readonly string[];
    },
  ) {
    super(`Browser launch failed at phase "${context.phase}"`);
  }
}

export class BrowserCrashedError extends Error {
  override readonly name = 'BrowserCrashedError';

  constructor(
    readonly context: {
      readonly sessionId: string;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly lastStderr: string;
    },
  ) {
    super(
      `Browser session ${context.sessionId} crashed (exit code ${context.exitCode ?? 'null'}, signal ${context.signal ?? 'none'})`,
    );
  }
}

export class ProfilePathRefusedError extends Error {
  override readonly name = 'ProfilePathRefusedError';

  constructor(readonly context: { readonly path: string; readonly reason: string }) {
    super(`Profile path refused: ${context.reason} (path: ${context.path})`);
  }
}

/** Not thrown — used only as a DoctorCheck detail when keychain is unreachable. */
export class KeychainUnreachableError extends Error {
  override readonly name = 'KeychainUnreachableError';

  constructor(cause: unknown) {
    super(`Keychain unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
