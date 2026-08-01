import { parseTemplate } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { buildCompletionNudge } from '../../src/runtime/orchestrator.js';

describe('@no-llm template completion nudge', () => {
  it('names manifest slots and anchors a draft without default output fields', () => {
    const parsed = parseTemplate(
      '# {{ title | text }}\n\n## Summary\n{{ summary }}\n\n## Risks\n{{ risks | list }}\n\n{{ sources }}',
    );
    if (!parsed.isOk) throw new Error('fixture template did not parse');
    const nudge = buildCompletionNudge(
      [
        {
          url: 'https://example.com/',
          finalUrl: null,
          title: 'Evidence',
          excerpt: null,
          fetchedAt: '2026-07-31T12:00:00.000Z',
          publishedAt: null,
          tool: 'web_search',
        },
      ],
      'The draft conclusion.',
      parsed.value,
    );

    expect(nudge).toContain('"report"');
    expect(nudge).toContain('"summary"');
    expect(nudge).toContain('"risks"');
    expect(nudge).not.toContain('"brief"');
    expect(nudge).not.toMatch(/overview/i);
    expect(nudge).toMatch(/previous message is your draft/i);
    expect(nudge).toMatch(/do not call web_search/i);
  });
});
