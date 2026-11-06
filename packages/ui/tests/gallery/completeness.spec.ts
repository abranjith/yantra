import { describe, expect, it } from 'vitest';

import { GALLERY_ENTRIES } from '../../src/gallery/entries.js';
import { PRIMITIVE_FAMILIES } from '../../src/primitives/families.js';
import * as primitives from '../../src/primitives/index.js';

const familyMembers = Object.values(PRIMITIVE_FAMILIES).flat();

describe('@no-llm Drshya gallery completeness', () => {
  it('assigns every exported primitive to exactly one family', () => {
    const exported = Object.keys(primitives).sort();

    expect([...familyMembers].sort()).toEqual(exported);
    expect(new Set(familyMembers).size).toBe(familyMembers.length);
  });

  it('covers all 16 primitive families of the M1 and M4 catalogue', () => {
    expect(Object.keys(PRIMITIVE_FAMILIES)).toHaveLength(16);
  });

  it('has exactly one gallery entry per primitive family', () => {
    const covered = GALLERY_ENTRIES.flatMap((entry) =>
      entry.primitive === null ? [] : [entry.primitive],
    ).sort();

    expect(covered).toEqual(Object.keys(PRIMITIVE_FAMILIES).sort());
  });

  it('marks every primitive entry interactive, so the harness walks its focus', () => {
    const notInteractive = GALLERY_ENTRIES.filter(
      (entry) => entry.primitive !== null && !entry.interactive,
    ).map((entry) => entry.id);

    expect(notInteractive).toEqual([]);
  });

  it('exports only components from the primitives barrel', () => {
    const notComponents = Object.entries(primitives)
      .filter(([name, value]) => {
        const component =
          typeof value === 'function' ||
          (typeof value === 'object' && value !== null && '$$typeof' in value);
        return !component || !/^[A-Z]/u.test(name);
      })
      .map(([name]) => name);

    expect(notComponents).toEqual([]);
  });
});
