/**
 * Writes `src/styles/theme.generated.css` from the Drshya token data.
 *
 *   tsx scripts/emit-tokens.ts           regenerate the file
 *   tsx scripts/emit-tokens.ts --check   validate only; exit 1 on a contract
 *                                        failure or when the file has drifted
 *
 * `build` runs the `--check` form, which is what makes the contrast gate a
 * build failure.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitThemeCss, GENERATED_THEME_PATH } from '../src/tokens/emit.js';
import { TokenContractError } from '../src/tokens/errors.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(packageRoot, GENERATED_THEME_PATH);

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/gu, '\n');
}

async function readExisting(): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function main(): Promise<number> {
  const check = process.argv.includes('--check');

  let css: string;
  try {
    css = emitThemeCss();
  } catch (error) {
    if (error instanceof TokenContractError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (!check) {
    await writeFile(target, css, 'utf8');
    process.stdout.write(`Wrote ${GENERATED_THEME_PATH}\n`);
    return 0;
  }

  const existing = await readExisting();
  if (existing === null || normalizeNewlines(existing) !== css) {
    process.stderr.write(
      `${GENERATED_THEME_PATH} is ${existing === null ? 'missing' : 'out of date'}. ` +
        'Run `pnpm --filter @yantra/ui emit:tokens` and commit the result.\n',
    );
    return 1;
  }
  process.stdout.write(`Tokens pass the contract and ${GENERATED_THEME_PATH} is current.\n`);
  return 0;
}

process.exitCode = await main();
