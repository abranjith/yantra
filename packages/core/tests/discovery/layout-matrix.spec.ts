import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { layoutMatrix } from '@yantra/test-helpers/layout-matrix';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { collectComposedInteractables } from '../../src/discovery/composed-handles.js';
import { deriveFieldIdentity } from '../../src/interaction/field-identity.js';
import { resolveInteractable } from '../../src/interaction/resolution.js';
import { layoutBrowser } from '../helpers/layout-browser.js';

describe('@no-llm synthetic layout matrix', () => {
  let browser: Awaited<ReturnType<typeof layoutBrowser>>;
  const counts: Record<string, { resolved: number; ambiguous: number; unresolvable: number }> = {};
  beforeAll(async () => {
    browser = await layoutBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });
  for (const fixture of layoutMatrix) {
    it(`${fixture.id}: never resolves to the wrong control`, async () => {
      await browser.page.setContent(fixture.html());
      const reads = vi.spyOn(browser.page, 'evaluateHandle');
      const observation = await browser.controller.observe({ cap: 400 });
      expect(reads).toHaveBeenCalledTimes(1);
      reads.mockRestore();
      const scan = await collectComposedInteractables(browser.page, { max: 400 });
      try {
        for (const raw of scan.records) {
          if (!raw.field) continue;
          const key = await scan.elements[raw.elementIndex]!.evaluate((element) =>
            element.getAttribute('data-fixture-key'),
          );
          const control = fixture.controls.find((item) => item.key === key);
          if (control?.expect.kind === 'label')
            expect(deriveFieldIdentity(raw.role, raw.field).origin).toBe(control.expect.origin);
          if (control?.expect.kind === 'ref-only')
            expect(deriveFieldIdentity(raw.role, raw.field).origin).toBe('none');
        }
      } finally {
        await Promise.all(scan.elements.map((element) => element?.dispose()));
      }
      const keys = await browser.page.evaluate(() => {
        const result: string[] = [];
        const visit = (root: ParentNode): void => {
          result.push(
            ...Array.from(root.querySelectorAll('[data-fixture-key]'), (element) =>
              element.getAttribute('data-fixture-key')!,
            ),
          );
          for (const element of root.querySelectorAll('*'))
            if (element.shadowRoot) visit(element.shadowRoot);
        };
        visit(document);
        return result;
      });
      expect(new Set(keys).size).toBe(fixture.controls.length);
      expect(keys.sort()).toEqual(fixture.controls.map((control) => control.key).sort());
      const keyByRef = new Map<string, string>();
      for (const entry of observation.interactables) {
        const key = await browser.controller.evaluateOn(entry.ref, (element) =>
          element.getAttribute('data-fixture-key'),
        );
        if (key) keyByRef.set(entry.ref, key);
      }
      const pageCounts = { resolved: 0, ambiguous: 0, unresolvable: 0 };
      for (const control of fixture.controls) {
        const expected = control.expect;
        if (expected.kind === 'ambiguous')
          expect(expected.with.every((key) => keys.includes(key))).toBe(true);
        const query =
          expected.kind === 'ref-only'
            ? [...keyByRef].find(([, key]) => key === control.key)![0]
            : expected.query;
        const resolution = resolveInteractable(query, observation.interactables);
        if (expected.kind === 'ambiguous') {
          expect(resolution.kind).toBe('ambiguous');
          if (resolution.kind === 'ambiguous')
            expect(resolution.offered.map((entry) => keyByRef.get(entry.ref)).sort()).toEqual(
              [...expected.with].sort(),
            );
        } else expect(resolution.kind).toBe('match');
        if (resolution.kind === 'match') {
          expect(keyByRef.get(resolution.entry.ref)).toBe(control.key);
          pageCounts.resolved += 1;
        } else if (resolution.kind === 'ambiguous') pageCounts.ambiguous += 1;
        else pageCounts.unresolvable += 1;
      }
      counts[fixture.id] = pageCounts;
    });
  }
  it('preserves a UTF-8 baseline without raw control bytes', () => {
    const path = fileURLToPath(new URL('./layout-matrix-baseline.json', import.meta.url));
    if (process.env.UPDATE_LAYOUT_BASELINE === '1')
      writeFileSync(path, `${JSON.stringify(counts, null, 2)}\n`, 'utf8');
    const bytes = readFileSync(path);
    expect(
      [...bytes].filter((byte) => byte < 32 && byte !== 10 && byte !== 13 && byte !== 9),
    ).toEqual([]);
    expect(Object.keys(JSON.parse(bytes.toString('utf8')))).toEqual(
      layoutMatrix.map((fixture) => fixture.id),
    );
  });
});
