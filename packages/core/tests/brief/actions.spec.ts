/** @no-llm Value-free action wording, inferred identities and inert capture links. */
import type { Brief, BriefAction } from '@yantra/protocol';
import { makeBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { briefToHtml } from '../../src/brief/to-html.js';
import { briefToMarkdown } from '../../src/brief/to-markdown.js';

const fill: BriefAction = {
  id: 'A1',
  kind: 'fill',
  label: 'First name',
  label_origin: 'structural',
  confidence: 'medium',
  section: 'Billing',
  ref: 'e1',
  epoch: 1,
  call_id: 'call-1',
  host: 'example.test',
  verification: { resolution: 'exact' },
};
const path = 'screenshots/capture-1-aaaaaaaaaaaa.png';
const capture: BriefAction = {
  id: 'A3',
  kind: 'capture',
  label: null,
  epoch: 1,
  call_id: 'call-3',
  host: 'example.test',
  artifacts: [
    {
      kind: 'screenshot',
      path,
      sha256: 'a'.repeat(64),
      bytes: 33,
      width: 1,
      height: 1,
      mime_type: 'image/png',
      sent_to_model: false,
    },
  ],
};

describe('@no-llm Brief action rendering', () => {
  it('preserves old output byte-for-byte and lists all action kinds', () => {
    const old = makeBrief();
    expect(briefToMarkdown({ ...old, actions: [] })).toBe(briefToMarkdown(old));
    expect(briefToHtml({ ...old, actions: [] })).toBe(briefToHtml(old));
    const brief: Brief = {
      ...old,
      actions: [
        fill,
        {
          ...fill,
          id: 'A2',
          kind: 'click',
          label_origin: undefined,
          confidence: undefined,
          verification: undefined,
        },
        capture,
        {
          id: 'A4',
          kind: 'submit_refused',
          label: 'Place order',
          signal: 'structural',
          epoch: 1,
          call_id: null,
          host: 'example.test',
        },
      ],
    };
    const md = briefToMarkdown(brief);
    expect(md).toContain(
      '## Actions\n\n- A1: filled "First name" (label inferred from page layout, medium confidence) in "Billing"; verified exact (call call-1)',
    );
    expect(md).toContain('- A2: clicked "First name" (call call-1)');
    expect(md).toContain(`- A3: captured screenshot: [part 1](${path}) (call call-3)`);
    expect(md).toContain(
      '- A4: did not click "Place order" (submit refused: it would submit the form)',
    );
    expect(briefToHtml(brief)).toContain(`<a href="${path}">part 1</a>`);
  });
  it.each([
    ['explicit', 'filled "First name"'],
    ['placeholder', 'label inferred from placeholder text'],
    ['title', 'label inferred from title text'],
    ['none', 'filled field e1 (no label found)'],
  ] as const)('renders %s label evidence visibly', (label_origin, expected) => {
    const md = briefToMarkdown({
      ...makeBrief(),
      actions: [{ ...fill, label_origin, confidence: undefined }],
    });
    expect(md).toContain(expected);
    if (label_origin === 'explicit') expect(md).not.toContain('label inferred');
  });
  it('shows withheld verification without a committed value', () => {
    const brief: Brief = {
      ...makeBrief(),
      actions: [
        {
          ...fill,
          label: 'Password',
          verification: { withheld: { reason: 'password', verdict: 'exact' } },
        },
      ],
    };
    expect(briefToMarkdown(brief)).toContain('; verified exact (value withheld)');
    expect(briefToHtml(brief)).toContain('; verified exact (value withheld)');
  });
  it('escapes labels and refuses an unchecked dangerous capture URL', () => {
    const unsafe: Brief = {
      ...makeBrief(),
      actions: [
        { ...fill, label: '<script>alert(1)</script>' },
        { ...capture, artifacts: [{ ...capture.artifacts![0]!, path: 'javascript:alert(1)' }] },
      ],
    };
    const html = briefToHtml(unsafe);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('javascript:alert(1)');
    expect(html).toContain('&lt;script&gt;');
    for (const output of [html, briefToMarkdown(unsafe)]) {
      expect(Buffer.from(output).includes(Buffer.from([0xc3, 0xa2]))).toBe(false);
      expect([...output].some((char) => char.charCodeAt(0) === 27)).toBe(false);
    }
  });
});
