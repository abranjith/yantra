import { makeBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { briefToHtml } from '../../src/brief/to-html.js';
import { briefToMarkdown } from '../../src/brief/to-markdown.js';

const brief = makeBrief({
  title: 'Sign-up form filled',
  key_findings: [],
  requirements: [
    {
      id: 'deliverable',
      label: 'actions of the sign-up form',
      status: 'met',
      reason: null,
      declared_in: null,
    },
    {
      id: 'fill',
      label: 'fill all eligible fields',
      status: 'unmet',
      reason: 'fields 10 of 48 filled',
      declared_in: 1,
      exemptions: [
        { label: 'Resume', reason: 'file_input' },
        { label: 'Account <b>id</b>', reason: 'read_only' },
      ],
      exempt_overflow: 2,
    },
    {
      id: 'artifact:screenshot:full_page',
      label: 'full-page screenshot',
      status: 'unmet',
      reason: 'not captured (scope_unsupported)',
      declared_in: 2,
    },
    {
      id: 'effects.submit',
      label: 'do not submit',
      status: 'not_applicable',
      reason: null,
      declared_in: 1,
    },
  ],
});

describe('@no-llm Brief requirements rendering (FEAT-054)', () => {
  it('renders a Requirements list with status, reason, revision, and exemptions in Markdown', () => {
    const md = briefToMarkdown(brief);
    expect(md).toContain('## Requirements');
    expect(md).toContain('- ✓ met: actions of the sign-up form\n');
    expect(md).toContain('- ✗ unmet: fill all eligible fields — fields 10 of 48 filled\n');
    expect(md).toContain(
      '  - Exempt: Resume (file upload), Account <b>id</b> (read-only) (+2 more)',
    );
    expect(md).toContain(
      '- ✗ unmet: full-page screenshot — not captured (scope_unsupported) (declared in revision 2)',
    );
    expect(md).toContain('- – not applicable: do not submit');
    expect(md.indexOf('## Requirements')).toBeLessThan(md.indexOf('> '));
    expect(md).toMatchSnapshot();
  });

  it('renders an escaped Requirements section in HTML', () => {
    const html = briefToHtml(brief);
    expect(html).toContain('<section class="requirements"><h2>Requirements</h2>');
    expect(html).toContain('<span class="unmet">✗ unmet</span>: fill all eligible fields');
    expect(html).toContain('Account &lt;b&gt;id&lt;/b&gt; (read-only)');
    expect(html).toContain('(declared in revision 2)');
    expect(html).toContain('.requirements .met');
    expect(html).not.toMatch(/<b>id/u);
    expect(html).toMatchSnapshot();
  });

  it('renders nothing extra for a Brief without requirements', () => {
    const plain = makeBrief();
    expect(briefToMarkdown(plain)).not.toContain('Requirements');
    expect(briefToHtml(plain)).not.toContain('requirements');
  });
});
