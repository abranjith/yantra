// Intentional boundary violation, loaded only by
// `packages/ui/tests/boundary-rules.spec.ts`: Drshya may take protocol
// *types* only; a value import pulls Zod schemas into browser code
// (plan_ui.md §8 "Dependency direction").
import { TaskEvent } from '@yantra/protocol';

export const fixtureValue = TaskEvent;
