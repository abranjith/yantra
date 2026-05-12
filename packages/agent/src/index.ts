import { PROTOCOL_VERSION } from '@yantra/protocol';

/**
 * Sentinel proving `@yantra/agent` resolves and consumes `@yantra/protocol`
 * without crossing the forbidden `@yantra/agent → @yantra/core` boundary.
 * Replaced with the real `LLMClient` adapter surface in FEAT-011.
 */
export const AGENT_PROTOCOL_VERSION = PROTOCOL_VERSION;
