import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BriefSource, TemplateManifest, TemplatedReport } from '@yantra/protocol';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTemplate } from '../../src/report-template/parse.js';
import { renderTemplate } from '../../src/report-template/render.js';
import { templatedReportToHtml } from '../../src/report-template/to-html.js';
import { writeReportArtifacts } from '../../src/report-template/write-artifacts.js';

const TEMPLATE = `---
name: exec-brief
---
# {{ title | text }}

## Executive Summary
{{ summary | markdown }}

## Risks
{{ risks | list }}

## Comparison
{{ comparison | table(Vendor, Price, Notes) }}

## Sources
{{ sources }}
`;

const execFixtureUrl = new URL('./fixtures/exec-brief.md', import.meta.url);
const guidedExecFixtureUrl = new URL('./fixtures/exec-brief-guidance.md', import.meta.url);

function manifest(text = TEMPLATE): TemplateManifest {
  const parsed = parseTemplate(text);
  if (!parsed.isOk) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

const sources: BriefSource[] = [
  {
    n: 1,
    url: 'https://example.com/report',
    final_url: null,
    host: 'example.com',
    title: 'Example Report',
    excerpt: null,
    fetched_at: '2026-07-31T00:00:00.000Z',
    published_at: null,
  },
];

function document(rendered: string): TemplatedReport {
  return {
    report_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    schema_version: '0.2',
    template: { name: 'exec-brief', source: 'saved', path: null, hash: 'a'.repeat(64) },
    title: 'Weekly Brief',
    slots: {},
    rendered_md: rendered,
    sources,
    metadata: {
      search_provider: null,
      synthesis: 'llm',
      deterministic_fallback_used: false,
      coverage: null,
      freshness: null,
      citation_verdict: null,
      usage: null,
      evidence: null,
      run_id: 'run-1',
    },
    notices: [],
  };
}

describe('@no-llm report-template rendering', () => {
  it('renders the exec template to stable Markdown', () => {
    const rendered = renderTemplate(
      manifest(),
      {
        title: 'Weekly Brief',
        summary: 'The **summary** is concise. [1]',
        risks: ['Supply delay', 'Budget pressure'],
        comparison: [['Acme', '$10', 'Preferred']],
      },
      sources,
    );
    expect(rendered).toMatchInlineSnapshot(`
      "# Weekly Brief

      ## Executive Summary
      The **summary** is concise. [1]

      ## Risks
      - Supply delay
      - Budget pressure

      ## Comparison
      | Vendor | Price | Notes |
      | --- | --- | --- |
      | Acme | $10 | Preferred |

      ## Sources
      1. [Example Report](https://example.com/report)"
    `);
  });

  it('renders empty lists without a stray bullet and one-row tables as GFM', () => {
    const rendered = renderTemplate(
      manifest(),
      { title: 'T', summary: 'S', risks: [], comparison: [['A', 'B', 'C']] },
      [],
    );
    expect(rendered).not.toContain('- \n');
    expect(rendered).toContain('| A | B | C |');
    expect(rendered).toContain('_No sources were consulted._');
  });

  it('escapes table delimiters and line breaks', () => {
    const rendered = renderTemplate(
      manifest(),
      { title: 'T', summary: 'S', risks: [], comparison: [['A|B', 'line\ntwo', 'C']] },
      [],
    );
    expect(rendered).toContain('| A\\|B | line<br>two | C |');
  });

  it('renders guided and unguided template twins byte-identically without comments', async () => {
    const [plainText, guidedText] = await Promise.all([
      readFile(execFixtureUrl, 'utf8'),
      readFile(guidedExecFixtureUrl, 'utf8'),
    ]);
    const values = {
      title: 'Weekly Brief',
      summary: 'Revenue increased because enterprise renewals accelerated.',
      risks: ['Supply delay', 'Budget pressure', 'Hiring capacity'],
      comparison: [['Acme', '$10', 'Preferred']],
    };
    const plain = renderTemplate(manifest(plainText), values, sources);
    const guided = renderTemplate(manifest(guidedText), values, sources);
    expect(guided).toBe(plain);
    expect(guided).not.toContain('<!--');
  });

  it('removes the directive line and its terminator before rendering', () => {
    const rendered = renderTemplate(
      manifest('## H\n<!-- guidance: Keep it short. -->\n{{ x }}'),
      { x: '<value>' },
      [],
    );
    expect(rendered).toBe('## H\n<value>');
  });

  it('renders script input inert and collapses javascript links and remote images', () => {
    const html = templatedReportToHtml(
      document(
        '# Safe\n\n<script>alert(1)</script> [click](javascript:alert(1)) ![remote](https://bad.test/x.png)',
      ),
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('https://bad.test/x.png');
  });

  it('promotes the report title to an h1 only when the template supplies none', () => {
    expect(templatedReportToHtml(document('Body with no heading.'))).toContain(
      '<h1>Weekly Brief</h1>',
    );

    const titled = templatedReportToHtml(document('# Own Title\n\nBody.'));
    expect(titled).toContain('<h1>Own Title</h1>');
    expect(titled).not.toContain('<h1>Weekly Brief</h1>');
  });

  it('renders a multi-line table cell as a line break, not as literal markup', () => {
    // renderTemplate encodes an in-cell newline as <br>; the HTML path has to
    // honor exactly that one tag or the reader sees "one<br>two".
    const rendered = renderTemplate(
      manifest(),
      {
        title: 'Weekly Brief',
        summary: 'Summary.',
        risks: [],
        comparison: [['Acme', '$10', 'Ships fast\nWarranty differs']],
      },
      sources,
    );
    expect(rendered).toContain('Ships fast<br>Warranty differs');

    const cell = new JSDOM(templatedReportToHtml(document(rendered))).window.document.querySelector(
      'tbody tr td:last-child',
    );
    expect(cell?.querySelectorAll('br').length).toBe(1);
    expect(cell?.textContent).toBe('Ships fastWarranty differs');
  });

  it('renders a rendered-Markdown table inside the shared scroll container', () => {
    const doc = new JSDOM(templatedReportToHtml(document('| A | B |\n| --- | --- |\n| 1 | 2 |')))
      .window.document;
    expect(doc.querySelector('.table-wrap > table')).not.toBeNull();
  });
});

describe('@no-llm report-template artifacts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-document-artifacts-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes document.json/md/html atomically', async () => {
    const report = document('# Weekly Brief\n\nBody.');
    const result = await writeReportArtifacts(join(root, 'run'), report);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(await readFile(result.value.mdPath, 'utf8')).toBe(`${report.rendered_md}\n`);
    expect(JSON.parse(await readFile(result.value.jsonPath, 'utf8'))).toEqual(report);
    expect(await readFile(result.value.htmlPath, 'utf8')).toBe(templatedReportToHtml(report));
    expect((await readdir(join(root, 'run'))).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('returns an error and leaves no tmp files when the run path is not a directory', async () => {
    const target = join(root, 'not-a-directory');
    await writeFile(target, 'occupied', 'utf8');
    const result = await writeReportArtifacts(target, document('# Report'));
    expect(result.isOk).toBe(false);
    await expect(access(`${target}.tmp`)).rejects.toThrow();
    expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
