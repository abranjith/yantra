/**
 * The shape of a client-generated invocation ID (protocol
 * `INVOCATION_ID_PATTERN`), restated here because browser code imports
 * protocol types only; a test pins the two together.
 */
export const INVOCATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
