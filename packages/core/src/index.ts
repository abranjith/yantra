import { PROTOCOL_VERSION } from '@yantra/protocol';

export { PROTOCOL_VERSION };

export * from './browser/index.js';
export * from './locator/index.js';
export * from './executor/index.js';
export * from './ethics/index.js';
export * from './audit/usage-writer.js';

/** @deprecated Use PROTOCOL_VERSION directly. This re-export will be removed in a future release. */
export const CORE_PROTOCOL_VERSION = PROTOCOL_VERSION;
