/** Custom error classes for the browser module. Each carries structured context. */

export class ChromeNotFoundError extends Error {
  override readonly name = 'ChromeNotFoundError';

  constructor(
    readonly context: { readonly os: string; readonly probed: readonly string[] },
  ) {
    super(`Chrome not found on ${context.os}. Probed: ${context.probed.join(', ')}`);
  }
}

export class ChromeVersionUnsupportedError extends Error {
  override readonly name = 'ChromeVersionUnsupportedError';

  constructor(
    readonly context: { readonly found: number; readonly required: number },
  ) {
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

  constructor(
    readonly context: { readonly path: string; readonly reason: string },
  ) {
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
