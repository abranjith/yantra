/**
 * Legacy migration tombstones. Amend only with a corresponding plan and memory
 * update; these entries prevent the removed scaffold from returning by accident.
 */
export const forbiddenPaths = [
  'packages/agent/src/client/pi-types.ts',
  'packages/agent/src/client/pi-adapter.ts',
  'packages/agent/src/client/anthropic.ts',
  'packages/agent/src/client/ollama.ts',
  'packages/agent/src/client/null.ts',
  'packages/agent/src/client/factory.ts',
  'packages/agent/src/client/pricing.ts',
  'packages/agent/src/client/recording.ts',
  'packages/agent/src/client/interface.ts',
  'packages/agent/src/discovery/propose.ts',
  'packages/agent/src/discovery/session-state.ts',
  'packages/agent/src/discovery/prompts.ts',
  'packages/agent/src/plan/generate.ts',
  'packages/agent/src/plan/validate.ts',
  'packages/agent/src/plan/user-facing-hints.ts',
  'packages/agent/src/prompts/assemble.ts',
  'packages/agent/src/prompts/guidance.md',
  'packages/agent/src/prompts/reprompt.ts',
  'packages/agent/src/audit/wrap.ts',
  'packages/agent/src/sanitizer-guard.ts',
  'packages/protocol/src/emit/tool-catalog.ts',
  'packages/protocol/generated/tool-catalog.json',
  'packages/protocol/generated/tool-catalog.ts',
] as const;

/** These were specific to the removed task-shaped agent client surface. */
export const forbiddenAgentSymbols = [
  'LLMClient',
  'NullLLMClient',
  'generatePlan(',
  'discovery.jsonl',
] as const;
