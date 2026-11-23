/**
 * The CLI's real `--json` documents, as the characterization suite recorded
 * them (`apps/cli/tests/characterization/baselines`), and fake host answers
 * shaped the way the host answers: params checked with the protocol schema
 * the host validates against, results built with the protocol result schema.
 *
 * Hand-written answers (`{ paths: [] }`, a `read.list` that accepted any
 * params) are how the generated Installation table and the Run-mode workflow
 * picker shipped broken with every test green.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ListResult, ReadListParams, ReadParams, ReadResult } from '@yantra/protocol';

const BASELINES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'cli',
  'tests',
  'characterization',
  'baselines',
);

/** The document `yantra … --json` printed in the recorded baseline `name`. */
export function cliDocument(name: string): unknown {
  const recorded = JSON.parse(readFileSync(join(BASELINES, `${name}.json`), 'utf8')) as {
    readonly stdout: string;
    readonly exitCode: number;
  };
  if (recorded.exitCode !== 0)
    throw new Error(`Baseline ${name} exited ${String(recorded.exitCode)}`);
  return JSON.parse(recorded.stdout) as unknown;
}

/** A generic reader's answer: params validated as the host does, `document` wrapped in a ReadResult. */
export function readAnswer(
  schema: string | null,
  document: unknown,
): (params: Record<string, unknown>) => ReadResult {
  return (params) => {
    ReadParams.parse(params);
    return ReadResult.parse({ schema, value: document, next_cursor: null });
  };
}

/** `read.list` for workflows: only the typed query the host accepts, answered with the bare document. */
export function workflowListAnswer(
  document: ListResult,
): (params: Record<string, unknown>) => ListResult {
  return (params) => {
    const query = ReadListParams.parse(params);
    if (query.target !== 'workflows')
      throw new Error(`Expected target workflows, got ${query.target}`);
    return ListResult.parse(document);
  };
}

/** A `list workflows --json` document holding `names`. */
export function workflowList(...names: readonly string[]): ListResult {
  return {
    schemaVersion: '0.2',
    kind: 'list',
    items: names.map((name, index) => ({
      kind: 'workflow',
      name,
      stepCount: index + 1,
      securityClass: 'public',
      modifiedAt: '2026-11-01T00:00:00.000Z',
    })),
  };
}
