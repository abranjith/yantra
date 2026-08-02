/**
 * Unit tests for the shared inert HTML shell.
 *
 * Two things are asserted here that the Brief/report renderer tests cannot see:
 * the *fidelity* of the escape-before-parse pipeline (content that is escaped
 * once must render as itself, not as visible entity text), and the shape of the
 * document shell every artifact inherits.
 */

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  escapeForMarkdown,
  escapeHtml,
  escapeHtmlOnce,
  hardenedMarkdown,
  inertDocument,
  safeHref,
} from '../../src/brief/html-shell.js';

/** The production pipeline: escape untrusted text, then parse it as Markdown. */
const render = (markdown: string): string =>
  hardenedMarkdown.parse(escapeForMarkdown(markdown)) as string;

/** Parse a rendered fragment so assertions read the browser's view, not bytes. */
const fragment = (html: string): Document => new JSDOM(`<body>${html}</body>`).window.document;

describe('@no-llm safeHref', () => {
  it('passes http(s) URLs through unchanged, in any case', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('HTTPS://EXAMPLE.COM')).toBe('HTTPS://EXAMPLE.COM');
  });

  it('rejects every other scheme and relative form', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'mailto:a@b.test',
      '//example.com/protocol-relative',
      '/relative/path',
      ' https://example.com',
      '',
    ]) {
      expect(safeHref(url)).toBeNull();
    }
  });
});

describe('@no-llm escapeHtml', () => {
  it('escapes every tag- and attribute-forming character', () => {
    expect(escapeHtml(`<a href="x" data-y='z'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('is deliberately not idempotent — a second pass double-encodes', () => {
    // This is why escapeHtmlOnce exists: anything read back off a Markdown
    // token has already been through escapeHtml once.
    expect(escapeHtml(escapeHtml('<'))).toBe('&amp;lt;');
  });
});

describe('@no-llm escapeForMarkdown', () => {
  it('encodes every character a tag needs to open, and only leaves `>` alone', () => {
    expect(escapeForMarkdown(`<script src="x" onload='y'>&`)).toBe(
      '&lt;script src=&quot;x&quot; onload=&#39;y&#39;>&amp;',
    );
  });

  it('leaves the blockquote marker intact so quoted lines survive the escape', () => {
    const doc = fragment(
      render('> Sampling ran once per retailer.\n>\n> A single reading is stale.'),
    );
    const quote = doc.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote?.querySelectorAll('p').length).toBe(2);
  });

  it('renders a stray angle bracket as text, not as markup', () => {
    const doc = fragment(render('Latency a -> b <not-a-tag> stays text.'));
    expect(doc.body.textContent).toBe('Latency a -> b <not-a-tag> stays text.\n');
    expect(doc.querySelectorAll('not-a-tag').length).toBe(0);
  });

  it('keeps a smuggled script inert even though > is unescaped', () => {
    const html = render('<script>alert(1)</script>');
    expect(/<script/iu.test(html)).toBe(false);
    expect(fragment(html).querySelectorAll('script').length).toBe(0);
  });
});

describe('@no-llm escapeHtmlOnce', () => {
  it('escapes unescaped input exactly like escapeHtml', () => {
    expect(escapeHtmlOnce(`<img src="x" onerror='alert(1)'>`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;',
    );
  });

  it('leaves well-formed named, decimal, and hex entities intact', () => {
    expect(escapeHtmlOnce('&amp; &lt; &#39; &#x27; &nbsp;')).toBe('&amp; &lt; &#39; &#x27; &nbsp;');
  });

  it('still escapes an ampersand that opens no valid entity', () => {
    expect(escapeHtmlOnce('a & b &notanentity &amp')).toBe('a &amp; b &amp;notanentity &amp;amp');
  });

  it('is idempotent', () => {
    const once = escapeHtmlOnce('<b> & "q" &amp; done');
    expect(escapeHtmlOnce(once)).toBe(once);
  });
});

describe('@no-llm hardenedMarkdown fidelity', () => {
  it('renders a fenced code block as its original text, not as entity soup', () => {
    const source = 'if (a < b && c > d) f("x", \'y\');';
    const doc = fragment(render(`\`\`\`js\n${source}\n\`\`\``));
    const code = doc.querySelector('pre > code');

    expect(code?.className).toBe('language-js');
    expect(code?.textContent?.trim()).toBe(source);
    // The live tag never materializes — only its text.
    expect(doc.querySelectorAll('script').length).toBe(0);
  });

  it('renders an inline code span as its original text', () => {
    const doc = fragment(render('Use `<div class="x">` here.'));
    expect(doc.querySelector('code')?.textContent).toBe('<div class="x">');
    expect(doc.querySelectorAll('div').length).toBe(0);
  });

  it('renders escaped markup inside a code block as inert text', () => {
    const doc = fragment(render('```\n<script>alert(1)</script>\n```'));
    expect(doc.querySelectorAll('script').length).toBe(0);
    expect(doc.querySelector('pre > code')?.textContent?.trim()).toBe('<script>alert(1)</script>');
  });

  it('only echoes a fence info string back as a class when it is a plain language token', () => {
    expect(render('```js extra-metadata\nx\n```')).toContain('class="language-js"');
    expect(render('```<script>\nx\n```')).not.toContain('class="language-');
    expect(render('```\nx\n```')).not.toContain('class="language-');
  });

  it('keeps query-string ampersands intact in a link href', () => {
    const doc = fragment(render('[docs](https://example.com/s?a=1&b=2&c=3)'));
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com/s?a=1&b=2&c=3');
    expect(doc.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps query-string ampersands intact in a GFM autolink', () => {
    const doc = fragment(render('See https://example.com/x?y=1&z=2 for details.'));
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com/x?y=1&z=2');
  });

  it('collapses a non-http(s) link to its text', () => {
    const html = render('[click](javascript:alert(1))');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('javascript:');
    expect(fragment(html).body.textContent).toContain('click');
  });

  it('degrades an image to labelled alt text with no remote load', () => {
    const doc = fragment(render('![a & b](https://remote.test/x.png)'));
    expect(doc.querySelectorAll('img').length).toBe(0);
    const alt = doc.querySelector('.img-alt');
    expect(alt?.textContent).toBe('a & b');
    expect(doc.body.innerHTML).not.toContain('remote.test');
  });

  it('drops an image with no alt text entirely', () => {
    expect(render('![](https://remote.test/x.png)')).not.toContain('img-alt');
  });

  it('wraps tables so a wide one scrolls instead of stretching the page', () => {
    const doc = fragment(render('| A | B |\n| --- | --- |\n| 1 | 2 |'));
    expect(doc.querySelector('.table-wrap > table')).not.toBeNull();
  });

  it('honors a hard line break in a table cell without reviving any other tag', () => {
    const doc = fragment(render('| A |\n| --- |\n| one<br>two<b>bold</b> |'));
    const cell = doc.querySelector('tbody td');

    expect(cell?.querySelectorAll('br').length).toBe(1);
    // Only <br> is re-authorized; every other tag stays inert text.
    expect(cell?.querySelectorAll('b').length).toBe(0);
    expect(cell?.textContent).toContain('<b>bold</b>');
  });
});

describe('@no-llm inertDocument', () => {
  const html = inertDocument('Title <script>alert(1)</script>', '<p>body</p>');

  it('emits a self-contained document with no executable or remote vectors', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    // Outbound source clicks must not leak the local artifact path.
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(/<script/iu.test(html)).toBe(false);
    expect(/<link\b/iu.test(html)).toBe(false);
    expect(/<img\b/iu.test(html)).toBe(false);
    expect(html).not.toContain('http://');
  });

  it('escapes the title and places the body inside the themed main element', () => {
    expect(html).toContain('<title>Title &lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).toContain('<main class="brief">\n<p>body</p>\n</main>');
  });

  it('ships one theme that is legible in light, dark, and print', () => {
    expect(html).toContain('color-scheme: light dark;');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('@media print');
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('is deterministic', () => {
    expect(inertDocument('t', '<p>b</p>')).toBe(inertDocument('t', '<p>b</p>'));
  });
});
