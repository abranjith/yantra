// Fixture: a clean `--json` render path. Every module reachable from this
// entrypoint imports no rendering toolchain — the guard must pass.
import { formatPayload } from './helper.js';

export function renderCleanJson(value: string): string {
  return formatPayload(value);
}
