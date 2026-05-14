import { PROTOCOL_VERSION } from '@yantra/protocol';

export { PROTOCOL_VERSION };

export * from './browser/index.js';
export * from './locator/index.js';

/** @deprecated Use PROTOCOL_VERSION directly. This re-export will be removed in a future release. */
export const CORE_PROTOCOL_VERSION = PROTOCOL_VERSION;
