// @no-llm
/**
 * CaptureGallery (FEAT-066 TASK-005): capture sets by part/parts, complete
 * and label badges, signed-image rendering delegated to the page, and
 * oversize files never loaded.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_IMAGE_CAP_BYTES,
  CaptureGallery,
  groupCaptureSets,
  type CaptureItem,
} from '../../src/instruments/CaptureGallery.js';
import { expectNoAxeViolations } from '../support/axe.js';

function item(path: string, overrides: Partial<CaptureItem> = {}): CaptureItem {
  return { path, bytes: 1_000, width: 100, height: 80, ...overrides };
}

const SET_OF_TWO = [
  item('screenshots/capture-1-aaaaaaaaaaaa-p1.png', {
    part: 1,
    parts: 2,
    complete: false,
    labels: ['truncated'],
  }),
  item('screenshots/capture-1-aaaaaaaaaaaa-p2.png', {
    part: 2,
    parts: 2,
    complete: false,
    labels: ['truncated'],
  }),
];
const SINGLE = item('screenshots/capture-2-bbbbbbbbbbbb.png', {
  part: 1,
  parts: 1,
  complete: true,
  labels: [],
});

function image(entry: CaptureItem) {
  return <span data-image={entry.path}>image</span>;
}

describe('CaptureGallery', () => {
  it('groups files into capture sets', () => {
    expect(groupCaptureSets([...SET_OF_TWO, SINGLE]).map((set) => set.length)).toEqual([2, 1]);
    expect(groupCaptureSets([item('a'), item('b')]).map((set) => set.length)).toEqual([1, 1]);
  });

  it('shows each set with its part count, completeness and labels', () => {
    const { container } = render(
      <CaptureGallery items={[...SET_OF_TWO, SINGLE]} renderImage={image} />,
    );

    expect(screen.getByRole('heading', { name: 'Capture set 1 — 2 parts' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Capture set 2 — 1 part' })).toBeTruthy();
    const complete = [...container.querySelectorAll('[data-part="complete"]')].map(
      (n) => n.textContent,
    );
    expect(complete).toEqual(['incomplete', 'complete']);
    expect(container.querySelector('[data-part="label"]')?.textContent).toBe('truncated');
    expect(screen.getByText('Part 2 of 2')).toBeTruthy();
    expect(container.querySelectorAll('[data-image]')).toHaveLength(3);
  });

  it('never renders an image over the cap; it offers the oversize action instead', () => {
    const renderImage = vi.fn(image);
    const big = item('captures/huge.png', { bytes: CAPTURE_IMAGE_CAP_BYTES + 1 });

    render(
      <CaptureGallery
        items={[big]}
        renderImage={renderImage}
        renderOversize={() => <button type="button">Show in folder</button>}
      />,
    );

    expect(renderImage).not.toHaveBeenCalled();
    expect(screen.getByText(/Too large to show here \(20\.0 MiB\)/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show in folder' })).toBeTruthy();
  });

  it('says where an audit capture went', () => {
    render(
      <CaptureGallery
        items={[
          item('screenshots/1-cccccccccccc.png', { sentToModel: true }),
          item('captures/x.png', { sentToModel: false }),
        ]}
        renderImage={image}
      />,
    );
    expect(screen.getByText('sent to model')).toBeTruthy();
    expect(screen.getByText('kept on this computer')).toBeTruthy();
  });

  it('marks the selected capture', () => {
    const { container } = render(
      <CaptureGallery items={[SINGLE]} renderImage={image} selectedPath={SINGLE.path} />,
    );
    expect(container.querySelector('[data-selected="true"]')?.getAttribute('data-capture')).toBe(
      SINGLE.path,
    );
  });

  it('says so when there are no captures', () => {
    render(<CaptureGallery items={[]} renderImage={image} />);
    expect(screen.getByText('No captures recorded for this run.')).toBeTruthy();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <CaptureGallery items={[...SET_OF_TWO, SINGLE]} renderImage={image} />,
    );
    await expectNoAxeViolations(container);
  });
});
