// Intentional architectural-boundary violation. Loaded by the boundary spec
// in `packages/core/src/_boundary-tests/` to assert `no-restricted-imports`
// fires. Excluded from build configs and from normal lint runs via the
// top-level `eslint.config.js` ignores entry.
import { CORE_PROTOCOL_VERSION } from '@yantra/core';

export const fixtureValue = CORE_PROTOCOL_VERSION;
