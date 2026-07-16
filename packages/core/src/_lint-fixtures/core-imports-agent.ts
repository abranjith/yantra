// Intentional architectural-boundary violation. Loaded by the boundary spec
// in `packages/core/tests/boundary-rules.spec.ts` to assert
// `no-restricted-imports` fires on the core -> agent direction
// (plan_agentic.md §3: protocol -> core -> agent -> cli). Excluded from build
// configs and from normal lint runs via the top-level `eslint.config.js`
// ignores entry.
import { AGENT_PROTOCOL_VERSION } from '@yantra/agent';

export const fixtureValue = AGENT_PROTOCOL_VERSION;
