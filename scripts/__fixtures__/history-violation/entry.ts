// Fixture: an LLM-payload-assembly entry that transitively reaches the index-db
// history store. The FEAT-018 privacy guard must flag the `index-db/` import in
// the reachable module.
import { assemblePrompt } from './assembler.js';

export function buildPrompt(query: string): string {
  return assemblePrompt(query);
}
