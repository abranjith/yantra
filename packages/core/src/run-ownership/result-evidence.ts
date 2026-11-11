import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readCommittedEvents } from '../run-channel/event-source.js';

/** `artifact_saved` kinds that carry the run's result, not its diagnostics. */
const RESULT_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  'brief',
  'templated_report',
  'output',
  'result',
]);

/** Files whose non-empty presence means a result was persisted. */
const RESULT_FILES = ['brief.json', 'outputs.json', 'document.json', 'document.md'] as const;

/**
 * The outcome of a run whose owner died before writing one (FEAT-064 D7).
 * It follows the evidence: `partial` when a result was persisted in this
 * ownership epoch (a result-bearing `artifact_saved` above `epochSeq`, or a
 * non-empty `brief.json`, `outputs.json` or document artifact), otherwise
 * `failed`. Never `aborted`: nobody chose to stop the run.
 */
export async function resultEvidence(
  runDir: string,
  epochSeq: number,
): Promise<'partial' | 'failed'> {
  for await (const { event } of readCommittedEvents(runDir, epochSeq + 1)) {
    if (
      event.kind === 'artifact_saved' &&
      RESULT_ARTIFACT_KINDS.has((event as { artifact_kind?: string }).artifact_kind ?? '')
    ) {
      return 'partial';
    }
  }
  for (const name of RESULT_FILES) {
    if (await nonEmptyFile(join(runDir, name))) return 'partial';
  }
  return 'failed';
}

async function nonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
