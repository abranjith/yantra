import { describe, expect, it } from 'vitest';

import { htmlToText, normalizeExtractedText } from '../../src/extraction/html-to-text.js';

describe('@no-llm extraction/html-to-text', () => {
  it('separates sibling block elements instead of gluing them', () => {
    // Distilled from the fifa.com news-hub capture: nav cards as nested divs.
    const html = `
      <div><h2>Match previews</h2><a href="#">See all</a></div>
      <div><span>NOR</span><span>1 FT 2</span><span>ENG</span></div>
      <div><p>Norway stand one win from an unprecedented semi-final, while England aim to return.</p></div>
    `;
    const text = htmlToText(html);

    expect(text).not.toMatch(/previewsSee/u);
    expect(text).not.toMatch(/[a-z][A-Z]/u);
    const blocks = text.split('\n\n');
    expect(blocks).toContain('Match previews');
    expect(blocks.some((block) => block.startsWith('Norway stand one win'))).toBe(true);
  });

  it('drops a consecutive duplicate block (doubled card titles)', () => {
    const html = `
      <div>The Semi-finals are here!</div>
      <div>The Semi-finals are here!</div>
      <div>Check out the match schedule.</div>
      <div>Check out the match schedule.</div>
    `;
    const text = htmlToText(html);

    expect(text).toBe('The Semi-finals are here!\n\nCheck out the match schedule.');
  });

  it('collapses adjacent inline duplicates (responsive d-none twin spans)', () => {
    // fifa.com renders each card title twice in sibling inline spans.
    const html =
      '<div><span>The Semi-finals are here!</span><span class="d-none d-md-block">The Semi-finals are here!</span>' +
      '<span>Norway break new ground as England aim to halt Haaland</span>' +
      '<span>Norway break new ground as England aim to halt Haaland</span></div>';
    const text = htmlToText(html);

    expect(text).toBe(
      'The Semi-finals are here!Norway break new ground as England aim to halt Haaland',
    );
  });

  it('keeps non-consecutive repeats (legitimate refrain)', () => {
    const html = '<p>Again.</p><p>Different middle.</p><p>Again.</p>';
    expect(htmlToText(html)).toBe('Again.\n\nDifferent middle.\n\nAgain.');
  });

  it('splits <br>-separated lines', () => {
    const text = htmlToText('<p>First line<br>Second line</p>');
    expect(text).toBe('First line\nSecond line');
  });

  it('never glues table rows or cells', () => {
    const html = `
      <table><tbody>
        <tr><th>Host countries</th><td>Canada</td><td>Mexico</td><td>United States</td></tr>
        <tr><th>Teams</th><td>48 (from 6 confederations)</td></tr>
      </tbody></table>
    `;
    const text = htmlToText(html);

    expect(text).not.toMatch(/CanadaMexico/u);
    expect(text).not.toMatch(/countriesCanada/u);
    const lines = text.split(/\n+/u);
    expect(lines).toContain('Canada');
    expect(lines).toContain('Mexico');
    expect(lines).toContain('United States');
  });

  it('strips numeric and single-letter footnote markers but keeps multi-letter brackets', () => {
    const text = htmlToText(
      '<p>The 2026 FIFA World Cup[A] is the 23rd edition.[45][46] The [USMNT] squad won [sic] again.</p>',
    );

    expect(text).toBe(
      'The 2026 FIFA World Cup is the 23rd edition. The [USMNT] squad won [sic] again.',
    );
  });

  it('strips named wiki markers', () => {
    const text = htmlToText('<p>Attendance was high[citation needed] before the final[edit].</p>');
    expect(text).toBe('Attendance was high before the final.');
  });

  it('normalizes NBSP, zero-widths, and pictographs', () => {
    const text = htmlToText('<p>MUST READS \u{1F525}️ News | FIFA​ World Cup 2026™</p>');

    expect(text).toBe('MUST READS News | FIFA World Cup 2026');
  });

  it('skips script/style/svg subtrees', () => {
    const text = htmlToText(
      '<div><script>var x = 1;</script><style>.a{}</style><svg><text>chart</text></svg><p>Real prose.</p></div>',
    );
    expect(text).toBe('Real prose.');
  });

  it('does not separate inline elements inside a sentence', () => {
    const text = htmlToText(
      '<p>Two of the world’s <b>best</b> strikers, <a href="#">Haaland</a> and Kane.</p>',
    );
    expect(text).toBe('Two of the world’s best strikers, Haaland and Kane.');
  });

  it('returns empty string for blank input and never throws on malformed HTML', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('   ')).toBe('');
    expect(htmlToText('<div><p>Unclosed <b>bold')).toContain('Unclosed bold');
  });

  it('is deterministic: same HTML yields identical output', () => {
    const html = '<div><h1>Title</h1><p>Body one.</p><p>Body two.</p></div>';
    expect(htmlToText(html)).toBe(htmlToText(html));
  });

  describe('normalizeExtractedText', () => {
    it('applies the same hygiene to text that never was HTML', () => {
      // A browser `innerText` read: NBSP, a footnote marker, ragged blank
      // lines, and a card title the page rendered twice.
      const text = normalizeExtractedText(
        '  Shipment status[3]  \n\n\n\nDelivered Monday\n\nDelivered Monday\n',
      );

      expect(text).toBe('Shipment status\n\nDelivered Monday');
    });

    it('is the normalization half of htmlToText', () => {
      // Pins the two as one pass: if the serializer's normalization ever
      // diverges from the exported one, live-page fallback reads silently stop
      // matching article reads.
      expect(htmlToText('<p>MUST READS \u{1F525}️ News | FIFA​ World Cup 2026™</p>')).toBe(
        normalizeExtractedText('MUST READS \u{1F525}️ News | FIFA​ World Cup 2026™'),
      );
    });

    it('returns empty string for blank input', () => {
      expect(normalizeExtractedText('')).toBe('');
      expect(normalizeExtractedText('  \n\n  ')).toBe('');
    });
  });
});
