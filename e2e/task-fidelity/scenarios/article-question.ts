/**
 * `article-question` (agentic tier): a factual question answered by one
 * long-form article — the shape today's pipeline was built for, kept in the
 * scorecard so collection-shaped work never regresses it.
 */

import { ARTICLE_FACTS, ARTICLE_TITLE } from '../fixtures/article-corpus.js';
import { ARTICLE_PATH } from '../fixtures/article.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import { fetchStep, publishStep } from './common.js';

const ARTICLE_URL = `${originOf('article')}${ARTICLE_PATH}`;

export const articleQuestion: Scenario = {
  id: 'article-question',
  sites: ['article'],
  command: 'research',
  goal:
    'How many days of essential load should a home backup battery be sized for, and what ' +
    'battery capacity does that imply for the example household? Use article.yantra.test',
  contract: {
    deliverable: 'answer',
    requiredFields: ['coverageDays', 'exampleCapacity'],
    filters: [],
    requiredSources: ['article.yantra.test'],
  },
  userLocation: null,
  serps: [
    {
      match: /battery|backup|article\.yantra\.test/i,
      results: [{ url: ARTICLE_URL, title: ARTICLE_TITLE }],
    },
  ],
  script: [
    fetchStep(ARTICLE_URL, 'article'),
    publishStep(
      'Backup battery sizing',
      `Size for ${ARTICLE_FACTS.coverageDays} of essential load: ${ARTICLE_FACTS.exampleCapacity} for the example household.`,
    ),
  ],
  expectations: [],
  tiers: ['agentic'],
  truth: () => [
    { itemId: 'article-answer', key: { title: ARTICLE_TITLE }, fields: { ...ARTICLE_FACTS } },
  ],
};
