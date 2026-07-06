/**
 * Golden-Brief harness (FEAT-014).
 *
 * The deterministic synthesizer is fully golden-testable: for a fixed input,
 * fixed options, and a fixed clock it must always produce the same Brief
 * (modulo the generated `brief_id`). This module loads the checked-in fixture
 * corpora, runs `DeterministicSynthesizer`, and normalizes the result so the
 * spec can byte-compare against the pinned canonical Briefs in `expected/`.
 *
 * Regenerate the pinned Briefs after an intentional change with:
 *
 *     pnpm golden:update
 *
 * which runs `e2e/golden-briefs/update.ts` (this same harness in write mode).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DeterministicSynthesizer } from '@yantra/core';
import type { SynthesisInput, SynthesisOptions } from '@yantra/core';
import type { Brief } from '@yantra/protocol';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Directory holding the `<name>.input.json` fixture corpora. */
export const CORPORA_DIR = join(HERE, 'corpora');
/** Directory holding the pinned `<name>.brief.json` canonical Briefs. */
export const EXPECTED_DIR = join(HERE, 'expected');

/** Placeholder that replaces the non-deterministic `brief_id` on normalize. */
export const NORMALIZED_BRIEF_ID = 'GOLDEN00000000000000000000';

/** Fixed synthesis options used for every golden run. */
export const GOLDEN_OPTS: SynthesisOptions = {
  strategy: 'deterministic',
  detail: 'standard',
  length: 'medium',
  scope: 'public',
  taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runId: 'golden-run',
  searchProvider: 'tavily',
};

/** Fixed clock so freshness classification is stable across machines/dates. */
export const goldenClock = (): Date => new Date('2026-06-15T00:00:00.000Z');

/** Returns the corpus fixture names (without extension), sorted. */
export function goldenCorpusNames(): string[] {
  return readdirSync(CORPORA_DIR)
    .filter((file) => file.endsWith('.input.json'))
    .map((file) => file.replace('.input.json', ''))
    .sort();
}

/** Loads a corpus fixture by name. */
export function loadCorpus(name: string): SynthesisInput {
  return JSON.parse(
    readFileSync(join(CORPORA_DIR, `${name}.input.json`), 'utf8'),
  ) as SynthesisInput;
}

/** Loads the pinned canonical Brief for a corpus. */
export function loadExpected(name: string): Brief {
  return JSON.parse(readFileSync(join(EXPECTED_DIR, `${name}.brief.json`), 'utf8')) as Brief;
}

/** Replaces the generated `brief_id` so two runs compare byte-for-byte. */
export function normalizeBrief(brief: Brief): Brief {
  return { ...brief, brief_id: NORMALIZED_BRIEF_ID };
}

/** Runs the deterministic synthesizer on a corpus and returns the outcome. */
export async function synthesizeCorpus(name: string): Promise<Brief> {
  const synth = new DeterministicSynthesizer({ clock: goldenClock });
  const result = await synth.synthesize(loadCorpus(name), GOLDEN_OPTS);
  if (!result.isOk) {
    throw new Error(`golden corpus "${name}" failed to synthesize: ${result.error.message}`);
  }
  return normalizeBrief(result.value.brief);
}

/** Pretty-prints a Brief the way the pinned files are stored. */
export function serializeBrief(brief: Brief): string {
  return `${JSON.stringify(brief, null, 2)}\n`;
}
