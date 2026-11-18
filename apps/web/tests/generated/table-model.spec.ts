import { APP_READ_SCHEMAS } from '@yantra/protocol/parity';
import { describe, expect, it } from 'vitest';

import {
  deriveColumns,
  resolvePointer,
  rowsFromEnvelope,
} from '../../src/generated/table-model.js';

describe('@no-llm generated table model', () => {
  it('derives described columns in schema order', () => {
    expect(
      deriveColumns(APP_READ_SCHEMAS.ConfigPathResult.shape.rows.element).map((c) => c.id),
    ).toEqual(['name', 'path', 'source']);
  });
  it('extracts common row arrays', () => {
    expect(rowsFromEnvelope({ rows: [{ id: 1 }] })).toEqual([{ id: 1 }]);
  });
  it('resolves escaped JSON pointers and rejects missing ones', () => {
    expect(resolvePointer({ 'a/b': { x: 1 } }, '/a~1b/x')).toBe(1);
    expect(() => resolvePointer({}, '/x')).toThrow('Missing');
  });
});
