/** Why the app host could not start; `yantra ui` maps every code to exit 3. */
export type HostStartErrorCode = 'assets_missing' | 'bind_failed' | 'lock_held' | 'not_ready';

/** The app host could not start. `remediation` names one next step. */
export class HostStartError extends Error {
  public override readonly name = 'HostStartError';

  public constructor(
    public readonly code: HostStartErrorCode,
    message: string,
    public readonly remediation: string,
  ) {
    super(message);
  }
}
