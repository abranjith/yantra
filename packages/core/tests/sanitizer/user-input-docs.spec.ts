import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseUserInputMarkers, type InputSegment } from '../../src/sanitizer/index.js';

interface DocumentedParserExample {
  readonly input: string;
  readonly segments: readonly InputSegment[];
}

describe('@no-llm user-input masking documentation', () => {
  it('keeps every machine-checked grammar example synchronized with the parser', async () => {
    const markdown = await readFile(
      new URL('../../../../docs/user-input-masking.md', import.meta.url),
      'utf8',
    );
    const examples = [...markdown.matchAll(/<!-- parser-example: (\{.*\}) -->/g)].map(
      (match) => JSON.parse(match[1]!) as DocumentedParserExample,
    );

    expect(examples.length).toBeGreaterThanOrEqual(6);
    for (const example of examples) {
      expect(parseUserInputMarkers(example.input)).toEqual(example.segments);
    }
  });
});
