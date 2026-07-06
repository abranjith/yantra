// Reachable from the violating LLM-payload entry. Importing the history store
// here is exactly the leak the personalization privacy guard must catch —
// history text must never have a path into a prompt.
import { readHistory } from './index-db/history-store.js';

export function assemblePrompt(query: string): string {
  return `${query}\n${readHistory()}`;
}
