/**
 * Shared run-capture helper (extracted from `web-fetch.ts` so `web_search` and
 * `web_fetch` persist oversized extracted content identically).
 *
 * When a tool's extracted text exceeds its inline byte threshold, the full text
 * is written to the run's `captures/` directory at mode 0600 and referenced by a
 * short `cap-<ulid>` id in the model-visible payload — the model sees a bounded
 * excerpt plus the reference, never an unbounded dump that could evict its
 * context (plan §5, memory §Security: capture files are 0600).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateUlid } from '@yantra/protocol';

/**
 * Persist full extracted content to the run's captures directory.
 *
 * @param runDir - Absolute path of the owning run directory.
 * @param text - The full extracted text to persist.
 * @returns The `cap-<ulid>` reference id for the written capture file.
 */
export async function writeCapture(runDir: string, text: string): Promise<string> {
  const id = `cap-${generateUlid()}`;
  const dir = join(runDir, 'captures');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.txt`), text, { encoding: 'utf8', mode: 0o600 });
  return id;
}
