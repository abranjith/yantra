/**
 * FEAT-069: frames never reach a model-visible path. The live view lives in
 * `@yantra/core`'s `live-view` module and is wired only by the orchestrator;
 * no tool module may import it or name its frame-carrying types, so nothing
 * a tool returns can carry a frame.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const toolsRoot = join(packageRoot, 'src', 'adapters', 'pi', 'tools');
const promptRoots = [join(packageRoot, 'src', 'runtime', 'prompt.ts')];

/** Live-view names that carry or produce frames. */
const FRAME_NAMES =
  /\b(?:LiveViewHub|ScreencastSource|ScreencastFrame|serveLiveViewOnRunSocket|encodeFramePayload|decodeFramePayload|installFocusGuard)\b|live-view/u;

function sources(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(directory, name));
}

describe('@no-llm live view model boundary', () => {
  it('keeps every tool module free of live-view imports and frame types', () => {
    const offenders = sources(toolsRoot).filter((path) =>
      FRAME_NAMES.test(readFileSync(path, 'utf8')),
    );
    expect(offenders.map((path) => relative(packageRoot, path).split(sep).join('/'))).toEqual([]);
  });

  it('keeps the prompt builder free of them too', () => {
    for (const path of promptRoots)
      expect(FRAME_NAMES.test(readFileSync(path, 'utf8'))).toBe(false);
  });

  it('wires the live view only in the orchestrator, by its page source', () => {
    const runtime = sources(join(packageRoot, 'src', 'runtime')).filter((path) =>
      /\bLiveViewHub\b|serveLiveViewOnRunSocket/u.test(readFileSync(path, 'utf8')),
    );
    expect(runtime.map((path) => relative(packageRoot, path).split(sep).join('/'))).toEqual([
      'src/runtime/orchestrator.ts',
    ]);
  });
});
