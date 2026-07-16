import { Writable } from 'node:stream';

import { renderBriefTerminal, run, type BriefDetailLevel } from '@yantra/cli';
import { briefToHtml, briefToMarkdown, type AskPipeline, type AskRunResult } from '@yantra/core';
import { validateBrief } from '@yantra/protocol';
import { canonicalBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

/**
 * Consolidated render drift-detection suite (FEAT-015, TASK-007).
 *
 * One canonical fixture Brief (`canonicalBrief` in `@yantra/test-helpers`) is
 * exercised across every surface the user can reach — styled terminal (3
 * detail × 2 color), portable `brief.md`, inert `brief.html`, and the machine
 * `--json` envelope driven through the real `ask` command. A change to the
 * fixture, any renderer, or the CLI dispatch trips several snapshots here at
 * once. Regenerate intentionally with `pnpm snapshots:update`.
 */

function captureStream() {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });
  return { stream, value: () => data };
}

const DETAIL_LEVELS: readonly BriefDetailLevel[] = ['overview', 'standard', 'full'];

/** Runs `ask` with a mock pipeline that returns the canonical Brief. */
async function runAsk(args: readonly string[]): Promise<string> {
  const stdout = captureStream();
  const stderr = captureStream();
  const result: AskRunResult = { brief: canonicalBrief, artifacts: null };

  const exitCode = await run(['ask', 'canonical fixture', '--no-llm', ...args], {
    askRuntime: {
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      createPipeline: () =>
        Promise.resolve({ run: () => Promise.resolve(result) } as unknown as AskPipeline),
    },
  });

  expect(exitCode).toBe(0);
  return stdout.value();
}

describe('@no-llm brief render surfaces (drift detection)', () => {
  for (const detail of DETAIL_LEVELS) {
    for (const noColor of [false, true]) {
      it(`terminal — detail=${detail} noColor=${noColor}`, () => {
        expect(
          renderBriefTerminal(canonicalBrief, { detail, noColor, width: 80 }),
        ).toMatchSnapshot();
      });
    }
  }

  it('brief.md artifact', () => {
    expect(briefToMarkdown(canonicalBrief)).toMatchSnapshot();
  });

  it('brief.html artifact', () => {
    expect(briefToHtml(canonicalBrief)).toMatchSnapshot();
  });

  it('--json envelope through the ask command', async () => {
    expect(await runAsk(['--json'])).toMatchSnapshot();
  });

  it('--json output is byte-stable across runs', async () => {
    const first = await runAsk(['--json']);
    const second = await runAsk(['--json']);
    expect(first).toBe(second);

    const payload = JSON.parse(first) as { kind: string; brief: unknown };
    expect(payload.kind).toBe('brief');
    expect(validateBrief(payload.brief).isOk).toBe(true);
  });

  it('--format md and --format html match the artifact renderers', async () => {
    expect(await runAsk(['--format', 'md'])).toBe(`${briefToMarkdown(canonicalBrief)}\n`);
    expect(await runAsk(['--format', 'html'])).toBe(briefToHtml(canonicalBrief));
  });
});
