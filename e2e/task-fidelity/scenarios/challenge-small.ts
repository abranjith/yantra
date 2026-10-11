/**
 * `challenge-small`: the variant today's size heuristic happens to escalate.
 * It already fails extraction and never becomes a source; what it lacks is a
 * classification — it reads as "no article", not as a challenge.
 */

import { equals, includesAll } from '../expectations.js';

import { challengeScenario, challengeUrl } from './challenge.js';
import {
  fieldOf,
  noticesOf,
  outcomeOf,
  requestsFor,
  resultLabelled,
  sourceUrlsOf,
} from './common.js';

const URL = challengeUrl('small');
const HOST = 'challenge-interstitial.yantra.test';

export const challengeSmall = challengeScenario('small', [
  {
    id: 'blocked-failure',
    owner: 'FEAT-050',
    measure: (run) => outcomeOf(resultLabelled(run, 'challenge')),
    target: equals({ status: 'error', errorCode: 'SITE_CHALLENGE' }),
    baseline: equals({ status: 'error', errorCode: 'EXTRACTION_EMPTY' }),
    note: 'G10: the read is classified as a challenge, not as an empty article.',
  },
  {
    id: 'blocked-notice',
    owner: 'FEAT-050',
    measure: (run) =>
      noticesOf(run)
        .filter((notice) => notice.source === HOST)
        .map((notice) => notice.kind),
    target: includesAll(['blocked']),
    baseline: equals(['extract_failed']),
    note: 'G10: the Brief discloses the challenge as `blocked`.',
  },
  {
    id: 'never-a-source',
    owner: 'current',
    measure: (run) => sourceUrlsOf(run).includes(URL),
    target: equals(false),
    note: 'A challenge page is never published as a source.',
  },
  {
    id: 'never-extracted',
    owner: 'current',
    measure: (run) => {
      const read = resultLabelled(run, 'challenge');
      return fieldOf(read, 'text') !== null || fieldOf(read, 'excerpt') !== null;
    },
    target: equals(false),
    note: 'A challenge page yields no extracted text to the agent.',
  },
  {
    id: 'http-then-one-render',
    owner: 'current',
    measure: (run) => requestsFor(run, URL),
    target: equals(2),
    note: 'Policy (b): the HTTP read plus exactly one browser render, never a retry loop.',
  },
]);
