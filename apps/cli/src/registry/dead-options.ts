/**
 * The dead-option list moved to `@yantra/protocol/commands` (FEAT-067) so the
 * app reads the same list; re-exported here for the CLI's existing imports.
 */
export {
  DEAD_OPTION_TODO,
  KNOWN_DEAD_OPTIONS,
  isKnownDeadOption,
  type KnownDeadOption,
} from '@yantra/protocol';
