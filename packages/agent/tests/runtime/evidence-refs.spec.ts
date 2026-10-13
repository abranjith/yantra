import { describe, expect, it } from 'vitest';

import { parseEvidenceRef } from '../../src/runtime/evidence-refs.js';
describe('@no-llm evidence reference grammar', () => {
  it.each(['S1', 'S12#r3'])('accepts %s', (ref) => expect(parseEvidenceRef(ref)).not.toBeNull());
  it.each(['S0', 's3', 'S3#r0', 'S3r1', '3', 'S3#', ' S1', 'S1#r9007199254740993'])(
    'rejects %s',
    (ref) => expect(parseEvidenceRef(ref)).toBeNull(),
  );
});
