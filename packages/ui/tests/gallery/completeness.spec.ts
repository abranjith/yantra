import { describe, expect, it } from 'vitest';

import { GALLERY_ENTRIES } from '../../src/gallery/entries.js';
import * as primitives from '../../src/primitives/index.js';

describe('@no-llm Drshya gallery completeness', () => {
  it('has a gallery entry for every exported primitive, and none for anything else', () => {
    const exported = Object.keys(primitives).sort();
    const covered = GALLERY_ENTRIES.flatMap((entry) =>
      entry.primitive === null ? [] : [entry.primitive],
    ).sort();

    expect(covered).toEqual(exported);
  });

  it('marks every primitive entry interactive, so the harness walks its focus', () => {
    const notInteractive = GALLERY_ENTRIES.filter(
      (entry) => entry.primitive !== null && !entry.interactive,
    ).map((entry) => entry.id);

    expect(notInteractive).toEqual([]);
  });

  it('exports only components from the primitives barrel', () => {
    const notComponents = Object.entries(primitives)
      .filter(([name, value]) => typeof value !== 'function' || !/^[A-Z]/u.test(name))
      .map(([name]) => name);

    expect(notComponents).toEqual([]);
  });
});
