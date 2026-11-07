/**
 * Writes the CLI surface characterization goldens (FEAT-062 TASK-001).
 *
 * Run once, from the pre-migration commander tree, and commit the output:
 *
 *   cd apps/cli && npx tsx scripts/capture-cli-surface.ts
 *
 * No later FEAT-062 task regenerates these files — they are the acceptance
 * bar for "`--help` is byte-identical", so the script refuses to touch an
 * existing fixture directory unless `--overwrite` is passed deliberately.
 * Never run prettier over the output (see `.prettierignore`).
 */

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { buildProgram } from '../src/program.js';
import { captureCliSurface } from '../tests/registry/surface.js';

const fixtureRoot = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'cli-surface');

async function main(): Promise<void> {
  const overwrite = process.argv.includes('--overwrite');
  if (existsSync(fixtureRoot)) {
    if (!overwrite) {
      process.stderr.write(
        `${fixtureRoot} already exists; the goldens are captured once. Pass --overwrite only to recapture on purpose.\n`,
      );
      process.exitCode = 1;
      return;
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  const files = await captureCliSurface(() => buildProgram());
  for (const file of files) {
    const target = join(fixtureRoot, ...file.relativePath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  process.stdout.write(`wrote ${String(files.length)} golden files to ${fixtureRoot}\n`);
}

await main();
