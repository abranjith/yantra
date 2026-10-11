/**
 * `article`: the long-form path today's pipeline was built for. Its extracted
 * text is pinned byte for byte, gating immediately: shape-aware extraction
 * must leave the article path exactly as it is (plan §7).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { equals, type Expectation } from '../expectations.js';
import { ARTICLE_FACTS, ARTICLE_TITLE } from '../fixtures/article-corpus.js';
import { ARTICLE_PATH } from '../fixtures/article.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  crossCuttingExpectations,
  fetchStep,
  fieldOf,
  publishStep,
  resultLabelled,
} from './common.js';

const ARTICLE_URL = `${originOf('article')}${ARTICLE_PATH}`;

/** The pinned golden: today's extracted article text, byte for byte. */
export const ARTICLE_GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'golden',
  'article.txt',
);

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'article-text-unchanged',
    owner: 'current',
    measure: (run) => fieldOf(resultLabelled(run, 'article'), 'text'),
    target: equals(readFileSync(ARTICLE_GOLDEN_PATH, 'utf8')),
    note: 'Plan §7 "article path unchanged": the extracted text is byte-identical to the golden.',
  },
  {
    id: 'article-shape',
    owner: 'FEAT-051',
    measure: (run) => fieldOf(resultLabelled(run, 'article'), 'shape'),
    target: equals('article'),
    baseline: equals(null),
    note: 'G2: an article page states its own shape.',
  },
];

export const article: Scenario = {
  id: 'article',
  sites: ['article'],
  command: 'research',
  goal: `How many days of essential load should a home backup battery cover? Use ${ARTICLE_URL}`,
  contract: {
    deliverable: 'answer',
    requiredFields: ['coverageDays', 'exampleCapacity'],
    filters: [],
    requiredSources: ['article.yantra.test'],
  },
  userLocation: null,
  serps: [{ match: 'battery', results: [{ url: ARTICLE_URL, title: ARTICLE_TITLE }] }],
  script: [
    fetchStep(ARTICLE_URL, 'article'),
    publishStep('Backup battery sizing', 'Read the sizing guide; see sources.'),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [
    { itemId: 'article-answer', key: { title: ARTICLE_TITLE }, fields: { ...ARTICLE_FACTS } },
  ],
};
