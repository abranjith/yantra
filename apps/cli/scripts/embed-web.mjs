/**
 * Embeds the built Yantra app into the CLI package (FEAT-065 TASK-012).
 *
 * Runs after `tsc -b` in `apps/cli`'s build: clears `dist/web`, then copies
 * `../web/dist` into it. The host serves `dist/web` (resolved relative to
 * `dist/ui-host.js`) and reads its build ID from `dist/web/build-id.json`.
 * The build fails, with the reason, when the app build is missing or
 * incomplete.
 *
 * Usage: `node scripts/embed-web.mjs [--from <web dist>] [--to <cli dist/web>]`.
 */

import { cp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Reads `--from` and `--to`, defaulting to the workspace layout. */
function parseArgs(args) {
  const options = {
    from: resolve(here, '..', '..', 'web', 'dist'),
    to: resolve(here, '..', 'dist', 'web'),
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--from' && flag !== '--to') || value === undefined) {
      throw new Error(`Unknown argument ${flag ?? ''}; expected --from <dir> and/or --to <dir>.`);
    }
    options[flag.slice(2)] = resolve(value);
  }
  return options;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function embed({ from, to }) {
  for (const required of ['index.html', 'build-id.json']) {
    if (!(await isFile(join(from, required)))) {
      throw new Error(
        `The Yantra app build is missing ${required} in ${from}. Build it first (pnpm --filter @yantra/web build, or pnpm build).`,
      );
    }
  }
  const { build_id: buildId } = JSON.parse(await readFile(join(from, 'build-id.json'), 'utf8'));
  if (typeof buildId !== 'string' || buildId.length === 0) {
    throw new Error(`${join(from, 'build-id.json')} has no build_id.`);
  }
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
  stdout.write(`Embedded the Yantra app (build ${buildId.slice(0, 12)}) into ${to}\n`);
}

try {
  await embed(parseArgs(argv.slice(2)));
} catch (error) {
  stderr.write(`embed-web: ${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
