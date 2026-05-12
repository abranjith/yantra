import { AGENT_PROTOCOL_VERSION } from '@yantra/agent';
import { CORE_PROTOCOL_VERSION } from '@yantra/core';
import { PROTOCOL_VERSION } from '@yantra/protocol';

/**
 * CLI entrypoint placeholder. Replaced by commander wiring in FEAT-012.
 *
 * Prints the protocol version reported by every workspace boundary; if they
 * ever disagree, the scaffold is broken.
 */
export const run = (): void => {
  console.log(
    `yantra (protocol=${PROTOCOL_VERSION}, core=${CORE_PROTOCOL_VERSION}, agent=${AGENT_PROTOCOL_VERSION})`,
  );
};
