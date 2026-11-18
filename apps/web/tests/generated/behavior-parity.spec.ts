import { findLeaf, parseInvocation } from '@yantra/protocol/commands';
import { describe, expect, it } from 'vitest';

import {
  buildInvocation,
  deriveFields,
  validateDraft,
  type FormField,
  type FormValues,
} from '../../src/generated/form-model.js';
import { SURFACE_DEFINITIONS } from '../../src/surfaces/definitions.js';

function sample(field: FormField): FormValues[string] {
  if (!field.takesValue) return true;
  if (field.inputKind.kind === 'enum') return field.inputKind.choices[0];
  if (field.inputKind.kind === 'path') return '/sandbox/fixture';
  if (field.inputKind.kind === 'duration') return '1s';
  if (field.inputKind.kind === 'number') return String(Math.max(field.inputKind.min ?? 1, 1));
  return 'fixture';
}

function requiredValues(fields: readonly FormField[]): FormValues {
  const values: Record<string, FormValues[string]> = {};
  const byFlag = new Map(
    fields.filter((field) => field.flag !== undefined).map((field) => [field.flag!, field]),
  );
  const add = (field: FormField): void => {
    values[field.id] = sample(field);
    for (const flag of field.requires) {
      const needed = byFlag.get(flag);
      if (needed !== undefined) add(needed);
    }
  };
  for (const field of fields.filter((item) => item.required)) add(field);
  return values;
}

const generatedPaths = [
  ...new Set(
    SURFACE_DEFINITIONS.flatMap((surface) => [
      ...surface.actions,
      ...surface.rowActions.map((action) => action.command),
    ]),
  ),
];

describe('@no-llm generated form behavior parity', () => {
  it.each(generatedPaths)('%s builds argv accepted by the canonical parser', (path) => {
    const command = findLeaf(path.split(' '));
    expect(command).toBeDefined();
    if (command === undefined) return;
    const fields = deriveFields(command);
    const values = requiredValues(fields);
    expect(validateDraft(fields, values)).toEqual([]);
    const invocation = buildInvocation(
      command,
      values,
      '/sandbox',
      () => '01JAAAAAAAAAAAAAAAAAAAAAAA',
    );
    const parsed = parseInvocation([...invocation.path, ...invocation.argv], {
      cwd: invocation.cwd,
      invocationId: invocation.invocation_id,
    });
    expect(parsed.isOk).toBe(true);
  });
});
