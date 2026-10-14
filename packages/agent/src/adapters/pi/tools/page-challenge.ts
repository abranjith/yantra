/** Browser-tier challenges have one run-wide terminal state, across read tools. */
import { FetchError, type ChallengeMarker } from '@yantra/core';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainFailure } from '../../../runtime/middleware.js';
import { recordFetchTierEvent } from '../../../runtime/run-health.js';
import type { RunServices } from '../../../runtime/run-services.js';

/** Refuse a previously challenged URL before another read or navigation. */
export function knownPageChallenge(services: RunServices, url: string): DomainFailure | null {
  const memo = services.documents.failureFor(url);
  if (memo?.browserChallenge !== true) return null;
  return challengeFailure(url, true);
}

/** Record the first live browser challenge, using the fetcher's terminality rule. */
export function recordPageChallenge(
  services: RunServices,
  url: string,
  marker: ChallengeMarker,
): DomainFailure {
  const failure = challengeFailure(url, false);
  const host = URL.canParse(url) ? new URL(url).hostname : '';
  recordFetchTierEvent(
    { kind: 'challenge', tier: 'browser', host, marker },
    services.runtimeLogger,
    services.runHealth,
  );
  services.documents.rememberFailure(
    url,
    new FetchError('Browser challenge', {
      url,
      kind: 'challenge',
      tier: 'browser',
      marker,
    }),
    { code: failure.errorCode, reason: failure.message, failure, browserChallenge: true },
  );
  return failure;
}

function challengeFailure(url: string, memoized: boolean): DomainFailure {
  const host = URL.canParse(url) ? new URL(url).hostname : '';
  return {
    ok: false,
    errorCode: 'SITE_CHALLENGE',
    message: renderAgentMessage('tool', 'SITE_CHALLENGE', 'challenge', { host }),
    retryable: false,
    details: {
      host,
      tier: 'browser',
      handoff: true,
      ...(memoized ? { already_attempted: true } : {}),
    },
    diagnostic: { host, cause: memoized ? 'already-attempted' : 'challenge' },
  };
}
