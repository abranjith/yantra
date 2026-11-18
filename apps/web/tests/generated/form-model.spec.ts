import { findLeaf, formatInvocation } from '@yantra/protocol/commands';
import { describe, expect, it } from 'vitest';

import {
  buildInvocation,
  deriveFields,
  UnsupportedFieldError,
  validateDraft,
} from '../../src/generated/form-model.js';

const leaf = (path: string[]) => {
  const value = findLeaf(path);
  if (value === undefined) throw new Error(path.join(' '));
  return value;
};

describe('@no-llm generated form model', () => {
  it('derives arguments and options in registry order and skips defaults', () => {
    const command = leaf(['schedule']);
    const fields = deriveFields(command);
    expect(fields.map((field) => field.flag ?? field.id)).toContain('--cron');
    const invocation = buildInvocation(
      command,
      { 'workflow-name': 'daily', cron: '0 8 * * 1', notify: 'desktop' },
      '/work',
      () => '01JAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(formatInvocation(invocation, 'posix')).toMatchObject({
      ok: true,
      text: "yantra schedule daily --cron '0 8 * * 1'",
    });
  });
  it('enforces required, conflicts and absolute paths', () => {
    expect(
      validateDraft(deriveFields(leaf(['browser', 'update'])), { dryRun: true, yes: true }).some(
        (item) => item.message.includes('conflicts'),
      ),
    ).toBe(true);
    expect(
      validateDraft(deriveFields(leaf(['template', 'save'])), { path: 'relative.md' }),
    ).toContainEqual(expect.objectContaining({ field: 'path' }));
  });
  it('refuses a secret input', () => {
    expect(() => deriveFields(leaf(['secret', 'set']))).toThrow(UnsupportedFieldError);
  });
});
