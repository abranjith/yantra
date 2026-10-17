/**
 * @no-llm task fidelity — the FEAT-054 `do` form fixture and helpers.
 *
 * The scenarios themselves run in the deterministic tier
 * (`task-fidelity.spec.ts`); this suite pins what they rely on: the form is
 * larger than the observation cap, submission is measurable from the server
 * side, and the new sources carry no raw control bytes.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderRoute, siteNamed } from './task-fidelity/fixtures/sites.js';
import {
  TEST_FORM_ELIGIBLE_FIELDS,
  TEST_FORM_PATH,
  TEST_FORM_SHORT_PATH,
  TEST_FORM_SUBMITTED_PATH,
  TEST_FORM_SUBMIT_EVENT_PATH,
  TEST_FORM_SUBMIT_NAME,
} from './task-fidelity/fixtures/test-form.js';
import type { ScenarioRun } from './task-fidelity/runner.js';
import { FORM_HOST, submissionsOf } from './task-fidelity/scenarios/do-form.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Every byte below 0x20 except tab, line feed, and carriage return, plus DEL. */
function controlBytes(bytes: Uint8Array): number[] {
  const found: number[] = [];
  bytes.forEach((byte, index) => {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      found.push(index);
    }
  });
  return found;
}

function requestRun(paths: readonly string[]): ScenarioRun {
  return {
    requests: paths.map((path, index) => ({
      seq: index + 1,
      scheme: 'http',
      host: FORM_HOST,
      path,
      query: '',
      method: 'GET',
    })),
  } as unknown as ScenarioRun;
}

describe('@no-llm task-fidelity test-form fixture (FEAT-054)', () => {
  const page = (path: string): string => {
    const rendered = renderRoute(siteNamed('test-form'), path);
    if (rendered === null) throw new Error(`no route ${path}`);
    return rendered.body;
  };

  it('has more fillable controls than the 50-entry observation cap', () => {
    const body = page(TEST_FORM_PATH);
    const controls = (body.match(/<(?:input|select|textarea)\b/gu) ?? []).length;
    expect(TEST_FORM_ELIGIBLE_FIELDS.length).toBeGreaterThan(50);
    expect(controls).toBeGreaterThan(50);
  });

  it('carries the exempt controls, both buttons, and the submission counter', () => {
    for (const path of [TEST_FORM_PATH, TEST_FORM_SHORT_PATH]) {
      const body = page(path);
      expect(body).toContain(`action="${TEST_FORM_SUBMITTED_PATH}"`);
      expect(body).toContain(TEST_FORM_SUBMIT_EVENT_PATH);
      expect(body).toContain(`<button>${TEST_FORM_SUBMIT_NAME}</button>`);
      expect(body).toContain('<button type="button">');
    }
    const long = page(TEST_FORM_PATH);
    expect(long).toMatch(/<input[^>]*disabled/u);
    expect(long).toMatch(/<input[^>]*readonly/u);
    expect(long).toContain('type="file"');
    expect(long).toContain('type="hidden"');
  });

  it('renders every route deterministically', () => {
    for (const route of siteNamed('test-form').routes) {
      expect(renderRoute(siteNamed('test-form'), route)).toEqual(
        renderRoute(siteNamed('test-form'), route),
      );
    }
  });
});

describe('@no-llm task-fidelity submission counter (FEAT-054)', () => {
  it('reads 0 for a fresh run with only page loads', () => {
    expect(submissionsOf(requestRun([TEST_FORM_PATH, TEST_FORM_SHORT_PATH, '/']))).toBe(0);
  });

  it('counts a submission navigation and every submit beacon', () => {
    expect(
      submissionsOf(
        requestRun([TEST_FORM_PATH, TEST_FORM_SUBMIT_EVENT_PATH, TEST_FORM_SUBMITTED_PATH]),
      ),
    ).toBe(2);
  });
});

describe('@no-llm task-fidelity FEAT-054 sources carry no control bytes', () => {
  it('finds no raw control byte in the fixture or the do scenarios', async () => {
    const files = [
      join(here, 'task-fidelity', 'fixtures', 'test-form.ts'),
      ...(await readdir(join(here, 'task-fidelity', 'scenarios')))
        .filter((name) => name.startsWith('do-'))
        .map((name) => join(here, 'task-fidelity', 'scenarios', name)),
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect({ file, bytes: controlBytes(await readFile(file)) }).toEqual({ file, bytes: [] });
    }
  });
});
