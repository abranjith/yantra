import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { GlyphNode } from '../../src/icons/glyphs/glyph.js';
import { Icon, ICON_STROKE_WIDTH } from '../../src/icons/Icon.js';
import { ICON_NAMES, ICON_REGISTRY, type IconName } from '../../src/icons/registry.js';

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  if (svg === null) {
    throw new Error('no <svg> rendered');
  }
  return svg;
}

/** The root attributes that define the SVG contract (class and data-* excluded). */
function contractAttributes(svg: SVGSVGElement): Record<string, string> {
  return Object.fromEntries(
    [...svg.attributes]
      .filter((attribute) => attribute.name !== 'class' && !attribute.name.startsWith('data-'))
      .map((attribute) => [attribute.name, attribute.value]),
  );
}

/** Every point a path visits (endpoints and moves), for a live-area check. */
function pathPoints(d: string): (readonly [number, number])[] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/gu) ?? [];
  const points: (readonly [number, number])[] = [];
  let x = 0;
  let y = 0;
  let command = '';
  let index = 0;
  const next = () => Number(tokens[index++]);
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (/[a-zA-Z]/u.test(token)) {
      command = token;
      index += 1;
      if (command === 'z' || command === 'Z') {
        continue;
      }
    }
    const relative = command === command.toLowerCase();
    switch (command.toLowerCase()) {
      case 'm':
      case 'l': {
        const dx = next();
        const dy = next();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        break;
      }
      case 'h': {
        const dx = next();
        x = relative ? x + dx : dx;
        break;
      }
      case 'v': {
        const dy = next();
        y = relative ? y + dy : dy;
        break;
      }
      case 'c': {
        // Control points count too: the curve stays inside their hull.
        for (let pair = 0; pair < 2; pair += 1) {
          const cx = next();
          const cy = next();
          points.push([relative ? x + cx : cx, relative ? y + cy : cy]);
        }
        const dx = next();
        const dy = next();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        break;
      }
      case 'a': {
        index += 5; // rx ry rotation large-arc sweep
        const dx = next();
        const dy = next();
        x = relative ? x + dx : dx;
        y = relative ? y + dy : dy;
        break;
      }
      default:
        throw new Error(`unsupported path command ${command} in ${d}`);
    }
    points.push([x, y]);
  }
  return points;
}

function outsideLiveArea(node: GlyphNode): string[] {
  const inside = (value: number) => value >= 2 && value <= 22;
  return node.flatMap(([element, attributes]) => {
    const n = (key: string) => Number(attributes[key]);
    switch (element) {
      case 'circle':
        return inside(n('cx') - n('r')) &&
          inside(n('cx') + n('r')) &&
          inside(n('cy') - n('r')) &&
          inside(n('cy') + n('r'))
          ? []
          : [`circle ${JSON.stringify(attributes)}`];
      case 'rect':
        return inside(n('x')) &&
          inside(n('x') + n('width')) &&
          inside(n('y')) &&
          inside(n('y') + n('height'))
          ? []
          : [`rect ${JSON.stringify(attributes)}`];
      case 'line':
        return [n('x1'), n('y1'), n('x2'), n('y2')].every(inside)
          ? []
          : [`line ${JSON.stringify(attributes)}`];
      case 'path':
        return pathPoints(attributes.d ?? '').every(([px, py]) => inside(px) && inside(py))
          ? []
          : [`path ${attributes.d ?? ''}`];
    }
  });
}

const GLYPH_NAMES = ICON_NAMES.filter((name) => name.startsWith('glyph.'));

describe('@no-llm Drshya icon registry', () => {
  it('has exactly one record per icon name, in order', () => {
    expect(Object.keys(ICON_REGISTRY)).toEqual([...ICON_NAMES]);
  });

  it('points every record at a real component (a missing Lucide export fails here)', () => {
    const missing = ICON_NAMES.filter((name) => {
      const component: unknown = ICON_REGISTRY[name].component;
      return component === undefined || component === null;
    });

    expect(missing).toEqual([]);
  });

  it('draws six custom glyphs, the rest from Lucide', () => {
    expect(GLYPH_NAMES).toEqual([
      'glyph.bindu',
      'glyph.contract',
      'glyph.capture',
      'glyph.handoff',
      'glyph.protected',
      'glyph.provenance',
    ]);
    expect(GLYPH_NAMES.every((name) => ICON_REGISTRY[name].source === 'glyph')).toBe(true);
    expect(
      ICON_NAMES.filter((name) => !name.startsWith('glyph.')).every(
        (name) => ICON_REGISTRY[name].source === 'lucide',
      ),
    ).toBe(true);
  });

  it('keeps every glyph inside the 2..22 live area of the 24 px grid', () => {
    const outside = GLYPH_NAMES.flatMap((name) => {
      const record = ICON_REGISTRY[name];
      return record.source === 'glyph'
        ? outsideLiveArea(record.node).map((element) => `${name}: ${element}`)
        : [];
    });

    expect(outside).toEqual([]);
  });

  it('draws glyphs with strokes, never fills', () => {
    const filled = GLYPH_NAMES.filter((name) => {
      const record = ICON_REGISTRY[name];
      return (
        record.source === 'glyph' && record.node.some(([, attributes]) => 'fill' in attributes)
      );
    });

    expect(filled).toEqual([]);
  });
});

describe('@no-llm Drshya Icon', () => {
  it.each(ICON_NAMES.map((name) => [name] as const))(
    'renders %s on the 24 px grid with a 1.75 currentColor stroke',
    (name: IconName) => {
      const svg = svgOf(render(<Icon name={name} />).container);

      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.getAttribute('stroke-width')).toBe(String(ICON_STROKE_WIDTH));
      expect(svg.getAttribute('fill')).toBe('none');
      expect(svg.childElementCount).toBeGreaterThan(0);
    },
  );

  it('renders at 16 px by default and 20 px on request', () => {
    const small = svgOf(render(<Icon name="action.copy" />).container);
    const large = svgOf(render(<Icon name="action.copy" size={20} />).container);

    expect(small.getAttribute('width')).toBe('16');
    expect(large.getAttribute('width')).toBe('20');
    expect(large.getAttribute('height')).toBe('20');
  });

  it('hides an unlabeled icon from assistive technology', () => {
    const svg = svgOf(render(<Icon name="outcome.failed" />).container);

    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.hasAttribute('role')).toBe(false);
  });

  it('names a labeled icon as an image', () => {
    render(<Icon name="outcome.fulfilled" label="Fulfilled" />);

    const image = screen.getByRole('img', { name: 'Fulfilled' });
    expect(image.hasAttribute('aria-hidden')).toBe(false);
  });

  it('passes className through and records its semantic name', () => {
    const svg = svgOf(render(<Icon name="nav.check" className="text-on-accent" />).container);

    expect(svg.getAttribute('class')).toContain('text-on-accent');
    expect(svg.getAttribute('data-icon')).toBe('nav.check');
  });

  it.each(GLYPH_NAMES.map((name) => [name] as const))(
    'gives %s exactly the root attributes of a rendered Lucide icon',
    (name: IconName) => {
      const lucide = contractAttributes(svgOf(render(<Icon name="nav.check" />).container));
      const glyph = contractAttributes(svgOf(render(<Icon name={name} />).container));

      expect(glyph).toEqual(lucide);
    },
  );
});
