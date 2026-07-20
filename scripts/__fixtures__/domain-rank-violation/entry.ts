import { buildPrompt } from './assembler.js';

export function prompt(query: string): string {
  return buildPrompt(query);
}
