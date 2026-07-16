// ---------------------------------------------------------------------------
// Agent provider startup errors (FEAT-022, plan_agentic.md §9).
//
// These carry the stable startup codes surfaced through the AgentProvider
// seam. Messages must be actionable and secret-free: they may name which
// credential SOURCE was tried and how to configure it, never key material.
// Agentic commands never degrade to a null client — startup problems are
// always one of these typed failures.
// ---------------------------------------------------------------------------

/** Stable startup error codes normalized at the provider seam (plan §9). */
export type AgentStartupErrorCode =
  | 'AGENT_MODEL_NOT_FOUND'
  | 'AGENT_AUTH_UNAVAILABLE'
  | 'AGENT_PROVIDER_UNAVAILABLE'
  | 'AGENT_SESSION_START_FAILED'
  | 'AGENT_ABORTED';

/**
 * Base class for typed agent startup failures.
 *
 * @example
 *   try {
 *     await provider.open(options);
 *   } catch (err) {
 *     if (err instanceof AgentStartupError) {
 *       render(err.toAgentError()); // { code, message } — safe for artifacts
 *     }
 *   }
 */
export abstract class AgentStartupError extends Error {
  /** Plan §9 stable code for this failure. */
  public abstract readonly code: AgentStartupErrorCode;

  /** Project this error onto the seam's render-safe `AgentError` shape. */
  public toAgentError(): { readonly code: AgentStartupErrorCode; readonly message: string } {
    return { code: this.code, message: this.message };
  }
}

/** The requested provider/model pair is not known to the model registry. */
export class AgentModelNotFoundError extends AgentStartupError {
  public readonly code = 'AGENT_MODEL_NOT_FOUND' as const;

  public constructor(
    public readonly provider: string,
    public readonly modelId: string,
    availableHint: string,
  ) {
    super(
      `Model "${modelId}" was not found for provider "${provider}". ${availableHint} ` +
        `Custom/local models (e.g. Ollama) are defined in Yantra's pinned models.json — ` +
        `see the model-configuration docs.`,
    );
    this.name = 'AgentModelNotFoundError';
  }
}

/** No usable credential could be resolved for the selected provider. */
export class AgentAuthUnavailableError extends AgentStartupError {
  public readonly code = 'AGENT_AUTH_UNAVAILABLE' as const;

  public constructor(
    public readonly provider: string,
    /** Which credential sources were tried, e.g. "managed store, environment". */
    public readonly sourcesTried: string,
    fixHint: string,
  ) {
    super(
      `No credentials available for provider "${provider}" (tried: ${sourcesTried}). ${fixHint}`,
    );
    this.name = 'AgentAuthUnavailableError';
  }
}

/** The provider backend cannot be reached or refused the connection. */
export class AgentProviderUnavailableError extends AgentStartupError {
  public readonly code = 'AGENT_PROVIDER_UNAVAILABLE' as const;

  public constructor(
    public readonly provider: string,
    reason: string,
  ) {
    super(`Provider "${provider}" is unavailable: ${reason}`);
    this.name = 'AgentProviderUnavailableError';
  }
}

/** Session construction failed for a reason other than model/auth/transport. */
export class AgentSessionStartFailedError extends AgentStartupError {
  public readonly code = 'AGENT_SESSION_START_FAILED' as const;

  public constructor(reason: string) {
    super(`Agent session failed to start: ${reason}`);
    this.name = 'AgentSessionStartFailedError';
  }
}

/** The session was aborted (user interrupt or budget exhaustion). */
export class AgentAbortedError extends AgentStartupError {
  public readonly code = 'AGENT_ABORTED' as const;

  public constructor(reason = 'the run was aborted before completion') {
    super(`Agent session aborted: ${reason}`);
    this.name = 'AgentAbortedError';
  }
}
