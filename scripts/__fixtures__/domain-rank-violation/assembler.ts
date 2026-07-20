// A prompt path must never gain access to raw local domain-ranking rows.
import { listDomainRanks } from './index-db/domain-rank-store.js';

export function buildPrompt(query: string): string {
  return `${query}\n${listDomainRanks().join(',')}`;
}
