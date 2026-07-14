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
    // Internal #src-n citation fragments are the only non-http(s) hrefs allowed.
    expect(/href="(?!https?:\/\/|#src-)/i.test(html)).toBe(false);
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
        // Every href is an http(s) URL or an internal #src-n citation fragment.
        expect(/href="(?!https?:\/\/|#src-)/i.test(html)).toBe(false);
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
                value === '' ||
                value.startsWith('http://') ||
                value.startsWith('https://') ||
                value.startsWith('#src-');
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

  it('renders a heavily-cited finding as three superscripts plus a +k affordance', () => {
    const sources = Array.from({ length: 9 }, (_, i) => ({
      n: i + 1,
      url: `https://s${i + 1}.example.com/page`,
      final_url: null,
      host: `s${i + 1}.example.com`,
      title: `Source ${i + 1}`,
      fetched_at: '2026-07-01T10:00:00.000Z',
      published_at: null,
    }));
    const html = briefToHtml(
      makeBrief({
        sources,
        overview: 'Answer first. [1]',
        key_findings: [
          {
            text: 'A widely reported claim about the topic.',
            citations: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            editorial: false,
            facet: null,
          },
        ],
      }),
    );

    // Exactly three visible citation superscripts, then a collapsed +6.
    expect(html).toContain('<sup class="cite"><a href="#src-1">1</a></sup>');
    expect(html).toContain('<sup class="cite"><a href="#src-3">3</a></sup>');
    expect(html).not.toContain('href="#src-4"');
    expect(html).toContain('title="also sources 4, 5, 6, 7, 8, 9"');
    expect(html).toMatch(/\+6<\/span><\/sup>/);
  });

  it('transforms inline [n] runs in the overview into muted superscripts', () => {
    const html = briefToHtml(makeBrief({ overview: 'Lowest price is $328. [1]' }));
    expect(html).toContain('<sup class="cite"><a href="#src-1">1</a></sup>');
    // No literal bracket marker survives in the rendered prose.
    expect(html).not.toMatch(/\[1\]/u);
  });

  it('renders a GFM key-figures section as an HTML table', () => {
    const html = briefToHtml(
      makeBrief({
        sections: [
          {
            heading: 'Numbers & figures',
            body_md:
              '| Figure | Context | Sources |\n| --- | --- | --- |\n| 48 teams | Expanded field | [1] |',
            citations: [1],
          },
        ],
      }),
    );
    const dom = new JSDOM(html);
    expect(dom.window.document.querySelector('section table')).not.toBeNull();
  });

  it('anchors every citation superscript to a Sources entry with a matching id', () => {
    const dom = new JSDOM(briefToHtml(canonicalBrief));
    const doc = dom.window.document;
    const anchors = Array.from(doc.querySelectorAll('sup.cite a'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') ?? '';
      expect(href.startsWith('#src-')).toBe(true);
      expect(doc.getElementById(href.slice(1))).not.toBeNull();
    }
  });

  it('leaves an inline marker literal when it resolves to no declared source', () => {
    // Only source 1 is declared; [9] cannot resolve and must stay literal text.
    const html = briefToHtml(makeBrief({ overview: 'A real cite [1] and a bogus one [9].' }));
    expect(html).toContain('<sup class="cite"><a href="#src-1">1</a></sup>');
    expect(html).toContain('[9]');
    expect(html).not.toContain('href="#src-9"');
  });
});
