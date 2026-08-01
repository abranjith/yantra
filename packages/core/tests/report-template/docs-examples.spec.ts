import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseTemplate } from '../../src/report-template/parse.js';

describe('@no-llm report-template documentation examples', () => {
  it('parses every fenced template in the authoring guide', async () => {
    const guide = await readFile(
      new URL('../../../../docs/report-templates.md', import.meta.url),
      'utf8',
    );
    const examples = [...guide.matchAll(/```markdown template\r?\n([\s\S]*?)```/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const example of examples) {
      const parsed = parseTemplate(example);
      expect(parsed).toMatchObject({ isOk: true });
    }
  });
});
