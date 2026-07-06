import type { Brief, Section } from '@yantra/protocol';
import { makeBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { CoverageTracker } from '../../src/research/coverage.js';
import type { SynthesisDoc } from '../../src/synthesis/types.js';

function makeDoc(url: string, text: string): SynthesisDoc {
  return {
    url,
    finalUrl: null,
    host: new URL(url).hostname,
    title: 'Title',
    fetchedAt: '2026-05-11T10:00:00.000Z',
    publishedAt: null,
    text,
    excerpt: null,
  };
}

function briefWithSections(sections: readonly Section[]): Brief {
  return makeBrief({ sections: [...sections] });
}

describe('@no-llm research/coverage', () => {
  it('seeds subtopics from section headings and recurring entities', () => {
    const tracker = new CoverageTracker();
    const docs = [
      makeDoc(
        'https://a.com/1',
        'Solar Power expanded rapidly. Solar Power adoption rose across regions.',
      ),
      makeDoc(
        'https://b.com/2',
        'Solar Power capacity grew again as Solar Power costs fell sharply.',
      ),
    ];

    tracker.seed(
      briefWithSections([{ heading: 'Grid Reliability', body_md: 'x', citations: [1] }]),
      docs,
    );

    const labels = tracker.views().map((view) => view.label);
    expect(labels).toContain('Grid Reliability');
    expect(labels).toContain('Solar Power');
    expect(tracker.isSeeded()).toBe(true);
  });

  it('marks a subtopic covered only once at least two docs evidence it', () => {
    const tracker = new CoverageTracker();
    const seededDocs = [
      makeDoc(
        'https://a.com/1',
        'Wind Energy grew. Wind Energy investment increased notably this year.',
      ),
      makeDoc(
        'https://b.com/2',
        'Wind Energy output rose while Wind Energy subsidies were extended widely.',
      ),
    ];

    tracker.seed(briefWithSections([]), seededDocs);
    // "Wind Energy" recurs in both seed docs -> covered from the start.
    expect(tracker.gaps()).not.toContain('Wind Energy');
    expect(tracker.score()).toBeGreaterThan(0);
  });

  it('surfaces uncovered section headings as gaps', () => {
    const tracker = new CoverageTracker();
    const docs = [
      makeDoc(
        'https://a.com/1',
        'Coral Reef bleaching accelerated. Coral Reef surveys recorded declines.',
      ),
      makeDoc(
        'https://b.com/2',
        'Coral Reef recovery lagged while Coral Reef temperatures stayed high.',
      ),
    ];

    tracker.seed(
      briefWithSections([{ heading: 'Deep Ocean Currents', body_md: 'x', citations: [] }]),
      docs,
    );

    // No doc evidences "Deep Ocean Currents" -> it is an uncovered gap.
    expect(tracker.gaps()).toContain('Deep Ocean Currents');
    expect(tracker.gaps()).not.toContain('Coral Reef');
  });

  it('transitions an uncovered subtopic to covered after more evidence arrives', () => {
    const tracker = new CoverageTracker();
    const seed = [
      makeDoc(
        'https://a.com/1',
        'Nuclear Fusion research advanced. Nuclear Fusion milestones were reported.',
      ),
      makeDoc(
        'https://b.com/2',
        'Nuclear Fusion funding grew as Nuclear Fusion labs expanded rapidly.',
      ),
    ];
    tracker.seed(
      briefWithSections([{ heading: 'Tokamak Design', body_md: 'x', citations: [] }]),
      seed,
    );
    expect(tracker.gaps()).toContain('Tokamak Design');

    const withMore = [
      ...seed,
      makeDoc(
        'https://c.com/3',
        'A new Tokamak Design emerged. The Tokamak Design improved confinement.',
      ),
      makeDoc(
        'https://d.com/4',
        'Engineers praised the Tokamak Design. That Tokamak Design set records.',
      ),
    ];
    tracker.update(withMore);

    expect(tracker.gaps()).not.toContain('Tokamak Design');
  });

  it('computes score as covered weight over total weight', () => {
    const tracker = new CoverageTracker();
    const docs = [
      makeDoc(
        'https://a.com/1',
        'Public Transit ridership rose. Public Transit fares held steady overall.',
      ),
      makeDoc(
        'https://b.com/2',
        'Public Transit expanded while Public Transit delays fell across the network.',
      ),
    ];
    // One covered entity subtopic ("Public Transit") + one uncovered heading.
    tracker.seed(
      briefWithSections([{ heading: 'Airport Rail Links', body_md: 'x', citations: [] }]),
      docs,
    );

    const score = tracker.score();
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('degrades to entity-only seeding when hop-1 has no sections', () => {
    const tracker = new CoverageTracker();
    const docs = [
      makeDoc(
        'https://a.com/1',
        'Electric Vehicles sold well. Electric Vehicles gained market share.',
      ),
      makeDoc(
        'https://b.com/2',
        'Electric Vehicles prices dropped as Electric Vehicles ranges improved.',
      ),
    ];

    tracker.seed(briefWithSections([]), docs);

    const labels = tracker.views().map((view) => view.label);
    expect(labels).toEqual(['Electric Vehicles']);
  });

  it('scores 0 when nothing has been seeded', () => {
    const tracker = new CoverageTracker();
    expect(tracker.score()).toBe(0);
    expect(tracker.gaps()).toEqual([]);
  });
});
