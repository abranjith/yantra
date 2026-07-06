// Fixture: a `--json` render path that transitively pulls the rendering
// toolchain. The guard must flag the `chalk` import in the reachable module.
import { styleHeading } from './styler.js';

export function renderStyledJson(value: string): string {
  return styleHeading(value);
}
