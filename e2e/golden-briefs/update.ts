/**
 * Golden-Brief regeneration script — `pnpm golden:update`.
 *
 * Runs the deterministic synthesizer over every checked-in corpus and rewrites
 * the pinned canonical Briefs in `expected/`. Run this ONLY after an
 * intentional change to the deterministic synthesizer, then review the diff:
 * an unexpected diff here is exactly the drift the golden suite is meant to
 * catch.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXPECTED_DIR, goldenCorpusNames, serializeBrief, synthesizeCorpus } from './harness.js';

async function main(): Promise<void> {
  mkdirSync(EXPECTED_DIR, { recursive: true });

  const names = goldenCorpusNames();
  for (const name of names) {
    const brief = await synthesizeCorpus(name);
    const target = join(EXPECTED_DIR, `${name}.brief.json`);
    writeFileSync(target, serializeBrief(brief), 'utf8');
    process.stdout.write(`updated ${name}.brief.json\n`);
  }

  process.stdout.write(`pinned ${names.length} golden Brief(s)\n`);
}

void main();
