/**
 * `challenge-large-main`: the variant today's size heuristic does not
 * escalate. It is extracted as content and published as a source — G10
 * pinned: "honor bot detection" is currently enforced by accident.
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

const URL = challengeUrl('large-main');
const HOST = 'challenge-interstitial.yantra.test';

export const challengeLargeMain = challengeScenario('large-main', [
  {
    id: 'blocked-failure',
    owner: 'FEAT-050',
    measure: (run) => outcomeOf(resultLabelled(run, 'challenge')),
    target: equals({ status: 'error', errorCode: 'SITE_CHALLENGE' }),
    baseline: equals({ status: 'ok', errorCode: null }),
    note: 'G10: a 200 challenge page with a `<main>` over 10 KB is read as a challenge.',
  },
  {
    id: 'blocked-notice',
    owner: 'FEAT-050',
    measure: (run) =>
      noticesOf(run)
        .filter((notice) => notice.source === HOST)
        .map((notice) => notice.kind),
    target: includesAll(['blocked']),
    baseline: equals([]),
    note: 'G10: the Brief discloses the challenge as `blocked`.',
  },
  {
    id: 'never-a-source',
    owner: 'FEAT-050',
    measure: (run) => sourceUrlsOf(run).includes(URL),
    target: equals(false),
    baseline: equals(true),
    note: 'G10: the challenge page is never published as a source.',
  },
  {
    id: 'never-extracted',
    owner: 'FEAT-050',
    measure: (run) => {
      const read = resultLabelled(run, 'challenge');
      return fieldOf(read, 'text') !== null || fieldOf(read, 'excerpt') !== null;
    },
    target: equals(false),
    baseline: equals(true),
    note: 'G10: the challenge boilerplate never reaches the agent as content.',
  },
  {
    id: 'http-then-one-render',
    owner: 'FEAT-050',
    measure: (run) => requestsFor(run, URL),
    target: equals(2),
    baseline: equals(1),
    note: 'Policy (b): an HTTP-tier challenge gets exactly one standard-browser render.',
  },
]);
