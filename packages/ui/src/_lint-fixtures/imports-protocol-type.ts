// Must lint clean: a type-only protocol import is the one dependency Drshya is
// allowed (plan_ui.md §8 "Dependency direction"). Loaded only by
// `packages/ui/tests/boundary-rules.spec.ts`.
import type { TaskEvent } from '@yantra/protocol';

export type FixtureEvent = TaskEvent;
