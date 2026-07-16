// Intentional architectural-boundary violation. Loaded by the boundary spec
// in `packages/core/tests/boundary-rules.spec.ts` to assert
// `no-restricted-imports` fires when the Pi SDK is imported anywhere in
// `packages/agent` outside `src/adapters/pi/` (plan_agentic.md §3). Excluded
// from build configs and from normal lint runs via the top-level
// `eslint.config.js` ignores entry.
import { VERSION } from '@earendil-works/pi-coding-agent';

export const fixtureValue = VERSION;
