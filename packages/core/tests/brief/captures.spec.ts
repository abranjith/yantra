import type { Brief, BriefArtifact } from '@yantra/protocol';
import { makeBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { captureLabels, captureTitle, isCaptureArtifactPath } from '../../src/brief/captures.js';
import { briefToHtml } from '../../src/brief/to-html.js';
import { briefToMarkdown } from '../../src/brief/to-markdown.js';

const SHA = 'ab'.repeat(32);

function artifact(overrides: Partial<BriefArtifact> = {}): BriefArtifact {
  return {
    kind: 'screenshot',
    scope: 'viewport',
    path: `screenshots/capture-1-${SHA.slice(0, 12)}.png`,
    sha256: SHA,
    bytes: 1000,
    width: 1280,
    height: 720,
    part: 1,
    parts: 1,
    complete: true,
    labels: [],
    ...overrides,
  };
}

function tiled(parts: number, extra: Partial<BriefArtifact> = {}): BriefArtifact[] {
  return Array.from({ length: parts }, (_, index) =>
    artifact({
      scope: 'full_page',
      path: `screenshots/capture-2-${SHA.slice(0, 12)}-p${index + 1}.png`,
      height: 4096,
      part: index + 1,
      parts,
      ...extra,
    }),
  );
}

/** Builds a Brief directly, bypassing the schema, as a renderer must survive. */
function withArtifacts(artifacts: readonly BriefArtifact[]): Brief {
  return { ...makeBrief({ title: 'Form filled' }), artifacts: [...artifacts] };
}

describe('@no-llm Brief captures rendering (FEAT-058)', () => {
  it('renders a Brief without artifacts exactly as before', () => {
    const plain = makeBrief({ title: 'Form filled' });

    expect(briefToMarkdown(withArtifacts([]))).toBe(briefToMarkdown(plain));
    expect(briefToHtml(withArtifacts([]))).toBe(briefToHtml(plain));
    expect(briefToMarkdown(plain)).not.toContain('Captures');
    expect(briefToHtml(plain)).not.toContain('captures');
  });

  it('links one viewport capture relatively in Markdown and HTML', () => {
    const brief = withArtifacts([artifact()]);
    const path = `screenshots/capture-1-${SHA.slice(0, 12)}.png`;

    expect(briefToMarkdown(brief)).toContain(
      `## Captures\n\n- [viewport screenshot](${path}), 1280x720`,
    );
    expect(briefToHtml(brief)).toContain(
      `<section class="captures"><h2>Captures</h2><ul><li><a href="${path}">viewport screenshot</a>, 1280x720</li></ul></section>`,
    );
  });

  it('renders a three-part set as three labeled lines', () => {
    const markdown = briefToMarkdown(withArtifacts(tiled(3)));

    for (const part of [1, 2, 3]) {
      expect(markdown).toContain(
        `- [full-page screenshot, part ${part} of 3](screenshots/capture-2-${SHA.slice(0, 12)}-p${part}.png), 1280x4096`,
      );
    }
  });

  it('labels an incomplete set and an element below the visible area', () => {
    const markdown = briefToMarkdown(
      withArtifacts([
        ...tiled(6, { complete: false, labels: ['truncated'] }).slice(0, 1),
        artifact({
          scope: 'element',
          path: `screenshots/capture-3-${SHA.slice(0, 12)}.png`,
          labels: ['beyond_viewport'],
        }),
      ]),
    );

    expect(markdown).toContain('part 1 of 6](');
    expect(markdown).toContain('1280x4096 (incomplete: truncated)');
    expect(markdown).toContain('element screenshot](');
    expect(markdown).toContain('1280x720 (below the visible area)');
  });

  it.each([
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a parent-escaping path', '../x.png'],
    ['an absolute URL', 'https://evil.example/x.png'],
    ['an HTML-breaking path', 'screenshots/"><script>x</script>.png'],
  ])('renders %s as escaped text with no anchor', (_label, path) => {
    const brief = withArtifacts([artifact({ path })]);

    const html = briefToHtml(brief);
    const markdown = briefToMarkdown(brief);

    const start = html.indexOf('<section class="captures">');
    const section = html.slice(start, html.indexOf('</section>', start));
    expect(section).toContain('viewport screenshot');
    expect(section).not.toContain('<a ');
    expect(html).not.toContain('<script>x');
    expect(markdown).not.toContain(`](${path})`);
  });

  it('uses ASCII punctuation in every capture line', () => {
    const markdown = briefToMarkdown(
      withArtifacts([...tiled(2, { complete: false, labels: ['clipped_width', 'truncated'] })]),
    );
    const start = markdown.indexOf('## Captures');
    const next = markdown.indexOf('\n## ', start + 1);
    const section = markdown.slice(start, next === -1 ? undefined : next);
    const lines = section.split('\n').filter((line) => line.startsWith('- '));

    expect(lines).toHaveLength(2);
    for (const line of lines) expect(/^[\x20-\x7e]*$/u.test(line)).toBe(true);
  });
});

describe('@no-llm capture wording helpers', () => {
  it('omits the part count for a single file', () => {
    expect(captureTitle(artifact())).toBe('viewport screenshot');
    expect(captureTitle(tiled(3)[1]!)).toBe('full-page screenshot, part 2 of 3');
  });

  it('names every incompleteness label and the off-screen label', () => {
    expect(captureLabels(artifact())).toBe('');
    expect(
      captureLabels(artifact({ complete: false, labels: ['clipped_width', 'truncated'] })),
    ).toBe('(incomplete: clipped_width, truncated)');
    expect(captureLabels(artifact({ labels: ['beyond_viewport'] }))).toBe(
      '(below the visible area)',
    );
  });

  it('accepts only engine-produced capture paths', () => {
    expect(isCaptureArtifactPath(`screenshots/capture-1-${SHA.slice(0, 12)}-p2.png`)).toBe(true);
    expect(isCaptureArtifactPath(`screenshots/1-${SHA.slice(0, 12)}.png`)).toBe(true);
    expect(isCaptureArtifactPath('screenshots/x.png')).toBe(false);
    expect(isCaptureArtifactPath(42)).toBe(false);
  });
});
