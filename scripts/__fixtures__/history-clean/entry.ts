// Fixture: an LLM-payload-assembly entry whose closure only touches preference
// text (never history). The guard must pass this.
import { renderContext } from './personalization.js';

export function buildPrompt(query: string): string {
  return `${query}\n${renderContext()}`;
}
