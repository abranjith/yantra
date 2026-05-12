import { PROTOCOL_VERSION } from '@yantra/protocol';

/**
 * Sentinel that proves `@yantra/core` resolves and consumes `@yantra/protocol`
 * across the workspace boundary. Replaced with the real engine surface by the
 * features that follow FEAT-001.
 */
export const CORE_PROTOCOL_VERSION = PROTOCOL_VERSION;
