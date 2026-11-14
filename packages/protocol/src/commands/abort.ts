/**
 * Which commands stop cleanly when asked (FEAT-067, from FEAT-072's
 * per-handler `honorsAbort`).
 *
 * A command honors abort when its handler threads the cancel signal through
 * its work, so a Stop ends it `aborted`. Any other command is force-stopped
 * after the 10 s grace and reconciled `interrupted` (FEAT-064). The app says
 * which before the user presses Stop.
 *
 * This table is the one rule: handlers whose answer depends on the
 * invocation (`ask` and `research` only in LLM mode, `doctor` only with
 * `--agent-smoke`) compute it through {@link honorsAbort}, and a CLI test
 * pins every handler binding to it. A command not listed never honors abort.
 */

import { conditionHolds, type InvocationFacts } from './execution.js';
import type { Condition } from './schema.js';

/** `always`, `never`, or only when a registry condition holds. */
export type AbortRule = 'always' | 'never' | { readonly when: Condition };

/** Every command whose Stop can be graceful, by registry entry id. */
export const ABORT_RULES: Readonly<Record<string, AbortRule>> = {
  ask: { when: { mode: 'llm' } },
  research: { when: { mode: 'llm' } },
  do: 'always',
  run: 'never',
  resume: 'never',
  doctor: { when: { option: '--agent-smoke', present: true } },
  'browser.install': 'always',
  'browser.update': 'always',
  'daemon.start': 'always',
};

/** The rule for `entryId`; `never` when it is not listed. */
export function abortRule(entryId: string): AbortRule {
  return Object.prototype.hasOwnProperty.call(ABORT_RULES, entryId)
    ? ABORT_RULES[entryId]!
    : 'never';
}

/** Whether a Stop of this invocation is graceful. Pure. */
export function honorsAbort(entryId: string, facts: InvocationFacts): boolean {
  const rule = abortRule(entryId);
  if (rule === 'always') return true;
  if (rule === 'never') return false;
  return conditionHolds(rule.when, facts);
}
