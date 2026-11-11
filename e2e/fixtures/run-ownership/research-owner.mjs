// A real `yantra research --no-llm` run, in its own process, against local
// fixtures (FEAT-064 acceptance). The command goes through the real CLI path
// (`run` from @yantra/cli), the real ResearchLoop and ownership session; only
// search and fetch are fixtures. The first fetch starts a long-lived child
// standing in for a browser, records it as the run's owned browser, and then
// hangs, so the run is live until it is killed or stopped.
//
// Usage: node research-owner.mjs
// Prints {"runDir":...} once the lease exists and {"browser":<pid>} once the
// stand-in browser is recorded.

import { spawn } from 'node:child_process';

import { run } from '@yantra/cli';
import {
  DeferredBrowserOwnershipRecorder,
  DeterministicSynthesizer,
  FollowUpQueryGenerator,
  ResearchLoop,
  RunOwnershipSession,
  UNKNOWN_START_TOKEN,
  identifyProcess,
} from '@yantra/core';

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
const recorder = new DeferredBrowserOwnershipRecorder();
let browserStarted = false;

const loop = new ResearchLoop({
  searchProvider: {
    name: 'duckduckgo',
    search: async (query) =>
      [1, 2].map((n) => ({
        url: `https://example.test/${encodeURIComponent(query)}-${n}`,
        title: `${query} ${n}`,
        snippet: query,
        source: 'duckduckgo',
        rank: n - 1,
        publishedAt: null,
      })),
  },
  fetcher: {
    fetch: async () => {
      if (!browserStarted) {
        browserStarted = true;
        // Detached: on Windows a non-detached child sits in libuv's
        // kill-on-close job and would die with this owner, leaving no orphan.
        const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
          detached: true,
        });
        browser.unref();
        const identity = (await identifyProcess(browser.pid)) ?? {
          pid: browser.pid,
          startToken: UNKNOWN_START_TOKEN,
        };
        await recorder.recordSpawned(identity);
        print({ browser: browser.pid });
      }
      return new Promise(() => undefined); // the run stays live
    },
  },
  extractor: { extract: async () => null },
  ethicsGate: { checkUrl: async () => ({ ok: true }) },
  synthesizer: new DeterministicSynthesizer(),
  queryGen: new FollowUpQueryGenerator(),
  logger: silent,
  ownershipRecorder: recorder,
  openOwnership: async (options) => {
    const session = await RunOwnershipSession.open(options);
    print({ runDir: options.runDir, runId: options.runId });
    return session;
  },
});

const code = await run(
  [
    'research',
    '--no-llm',
    '--fetch-timeout',
    '600000',
    '--pipeline-timeout',
    '10m',
    'electric vehicles',
  ],
  {
    runStartSweep: null,
    researchRuntime: {
      resolveDefaults: () => Promise.resolve(new Map()),
      createLoop: () => Promise.resolve(loop),
    },
  },
);
process.exit(code);
