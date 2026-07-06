import { validateBrief } from '@yantra/protocol';
import { canonicalBrief, makeBrief } from '@yantra/test-helpers';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { briefToHtml } from '../../src/brief/to-html.js';

import { briefArb } from './arbitraries.js';

describe('@no-llm briefToHtml', () => {
  it('renders the canonical Brief to a stable self-contained document', () => {
    expect(briefToHtml(canonicalBrief)).toMatchSnapshot();
  });

  it('produces an inert, self-contained document shell', () => {
    const html = briefToHtml(canonicalBrief);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<style>');
    // No scripts, no external stylesheets/images.
    expect(/<script/i.test(html)).toBe(false);
    expect(/<link\b/i.test(html)).toBe(false);
    expect(/<img\b/i.test(html)).toBe(false);
    // Source links are real anchors carrying the hardened rel.
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<table class="comparison">');
  });

  it('escapes injected markup so it renders as inert text, not live tags', () => {
    const html = briefToHtml(
      makeBrief({
        title: '<script>alert(1)</script>',
        overview: 'Danger <img src=x onerror=alert(2)> here [1]',
        notices: [{ source: '<b>evil</b>', reason: '"><svg onload=alert(3)>', kind: 'other' }],
      }),
    );

    expect(/<script/i.test(html)).toBe(false);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The onerror payload survives only as escaped, inert text — never as a
    // live attribute (the authoritative on*-handler check is the DOM test).
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('neutralizes javascript: and data: source URLs to plain text', () => {
    const html = briefToHtml(
      makeBrief({
        sources: [
          {
            n: 1,
            url: 'javascript:alert(1)',
            final_url: null,
            host: 'evil.example.com',
            title: 'Evil source',
            fetched_at: '2026-07-01T10:00:00.000Z',
            published_at: null,
          },
        ],
      }),
    );

    // The dangerous URL never becomes an href; the label survives as text.
    expect(/href="(?!https?:\/\/)/i.test(html)).toBe(false);
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).toContain('Evil source');
  });

  it('emits no executable string vectors for any dangerous Brief (500 runs)', () => {
    fc.assert(
      fc.property(briefArb({ dangerous: true }), (brief) => {
        expect(validateBrief(brief).isOk).toBe(true);

        const html = briefToHtml(brief);
        // No live script or dangerous embedding tags.
        expect(/<script/i.test(html)).toBe(false);
        expect(/<\/script/i.test(html)).toBe(false);
        expect(/<(iframe|object|embed|link|img)\b/i.test(html)).toBe(false);
        // Every href attribute must be an http(s) URL — no javascript:/data:.
        expect(/href="(?!https?:\/\/)/i.test(html)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('parses to a DOM with no scripts, event handlers, or unsafe URLs', () => {
    fc.assert(
      fc.property(briefArb({ dangerous: true }), (brief) => {
        const dom = new JSDOM(briefToHtml(brief));
        const doc = dom.window.document;

        expect(doc.querySelectorAll('script, iframe, object, embed').length).toBe(0);

        for (const el of Array.from(doc.querySelectorAll('*'))) {
          for (const attr of Array.from(el.attributes)) {
            // No inline event handlers survived.
            expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
            if (attr.name === 'href' || attr.name === 'src') {
              const value = attr.value.trim().toLowerCase();
              const safe =
                value === '' || value.startsWith('http://') || value.startsWith('https://');
              expect(safe).toBe(true);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is deterministic — identical input yields identical bytes', () => {
    expect(briefToHtml(canonicalBrief)).toBe(briefToHtml(canonicalBrief));
  });
});
