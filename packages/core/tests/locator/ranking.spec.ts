// @vitest-environment jsdom

import * as fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import { rankCandidates } from '../../src/locator/ranking.js';

describe('@no-llm rankCandidates', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('testid candidate is ranked first when data-testid is present', () => {
    document.body.innerHTML =
      '<button data-testid="submit-btn" aria-label="Submit form">Submit</button>';
    const el = document.querySelector('button')!;
    const ranking = rankCandidates(el);
    expect(ranking.candidates[0]?.intent.kind).toBe('testid');
    expect(ranking.candidates[0]?.score).toBeGreaterThanOrEqual(0.9);
  });

  it('role candidate is ranked first when no testid but accessible role+name', () => {
    document.body.innerHTML = '<button>Sign in</button>';
    const el = document.querySelector('button')!;
    const ranking = rankCandidates(el);
    expect(ranking.candidates[0]?.intent.kind).toBe('role');
  });

  it('label candidate appears above CSS when label is present', () => {
    document.body.innerHTML = `
      <label for="em">Email</label>
      <input id="em" type="email">
    `;
    const el = document.querySelector('input')!;
    const ranking = rankCandidates(el);

    const labelIdx = ranking.candidates.findIndex((c) => c.intent.kind === 'label');
    const cssIdx = ranking.candidates.findIndex((c) => c.intent.kind === 'css');

    if (labelIdx !== -1 && cssIdx !== -1) {
      expect(labelIdx).toBeLessThan(cssIdx);
    }
  });

  it('xpath is always last (lowest score)', () => {
    document.body.innerHTML = '<div class="css-abc123"><span>text</span></div>';
    const el = document.querySelector('span')!;
    const ranking = rankCandidates(el);

    const lastCandidate = ranking.candidates.at(-1);
    expect(lastCandidate?.intent.kind).toBe('xpath');
  });

  it('respects topN cap', () => {
    document.body.innerHTML = '<button data-testid="x" aria-label="Y">Z</button>';
    const el = document.querySelector('button')!;
    const ranking = rankCandidates(el, { topN: 2 });
    expect(ranking.candidates).toHaveLength(2);
  });

  it('topN defaults to 5', () => {
    document.body.innerHTML = '<button data-testid="x" aria-label="Y">Z</button>';
    const el = document.querySelector('button')!;
    const ranking = rankCandidates(el);
    expect(ranking.candidates.length).toBeLessThanOrEqual(5);
  });

  it('target metadata reflects element tag and accessible name', () => {
    document.body.innerHTML = '<button aria-label="Submit">Submit</button>';
    const el = document.querySelector('button')!;
    const ranking = rankCandidates(el);
    expect(ranking.target.tagName).toBe('button');
    expect(ranking.target.accessibleName).toBe('Submit');
  });

  it('produces identical ordering on repeated calls (deterministic)', () => {
    document.body.innerHTML = '<button data-testid="btn" aria-label="Click me">Click</button>';
    const el = document.querySelector('button')!;
    const r1 = rankCandidates(el);
    const r2 = rankCandidates(el);
    expect(r1.candidates.map((c) => c.intent.kind)).toEqual(
      r2.candidates.map((c) => c.intent.kind),
    );
  });

  it('priority invariant: testid score >= role score >= label score', () => {
    document.body.innerHTML = `
      <label for="e">Email</label>
      <input id="e" type="email" data-testid="email-input" aria-label="Email input">
    `;
    const el = document.querySelector('input')!;
    const ranking = rankCandidates(el);

    const testidCandidate = ranking.candidates.find((c) => c.intent.kind === 'testid');
    const roleCandidate = ranking.candidates.find((c) => c.intent.kind === 'role');
    const labelCandidate = ranking.candidates.find((c) => c.intent.kind === 'label');

    if (testidCandidate && roleCandidate) {
      expect(testidCandidate.score).toBeGreaterThanOrEqual(roleCandidate.score);
    }
    if (roleCandidate && labelCandidate) {
      expect(roleCandidate.score).toBeGreaterThanOrEqual(labelCandidate.score);
    }
  });

  it('property: element with data-testid always has testid as first candidate', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[\w-]+$/.test(s)),
        (testid) => {
          document.body.innerHTML = `<button data-testid="${testid}">Click</button>`;
          const el = document.querySelector('button')!;
          const ranking = rankCandidates(el);
          return ranking.candidates[0]?.intent.kind === 'testid';
        },
      ),
    );
  });

  it('scores are all non-negative', () => {
    document.body.innerHTML = '<input type="text">';
    const el = document.querySelector('input')!;
    const ranking = rankCandidates(el);
    for (const candidate of ranking.candidates) {
      expect(candidate.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('sorted descending by score', () => {
    document.body.innerHTML = '<button data-testid="x" aria-label="Y">Z</button>';
    const el = document.querySelector('button')!;
    const ranking = rankCandidates(el);
    for (let i = 1; i < ranking.candidates.length; i++) {
      expect(ranking.candidates[i - 1]!.score).toBeGreaterThanOrEqual(ranking.candidates[i]!.score);
    }
  });
});
