// Intentional boundary violation, loaded only by
// `packages/ui/tests/boundary-rules.spec.ts`: Drshya must never import the
// engine (plan_ui.md §8 "Dependency direction").
import { detectChrome } from '@yantra/core';

export const fixtureValue = detectChrome;
