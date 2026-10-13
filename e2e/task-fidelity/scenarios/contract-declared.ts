/**
 * `contract-declared`: a research run declares its task contract in the same
 * turn as its first search (FEAT-052, plan G9 and §12 item 3).
 *
 * The contract is recorded, persisted, echoed once, and audited, and the
 * call costs no extra turn: the script has the same number of turns as the
 * same moves without it.
 */

import { TaskContractRecord } from '@yantra/protocol';

import type { ScriptStep } from '../agent/scripted-provider.js';
import { equals, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  contractEchoesOf,
  contractNoticesOf,
  contractOf,
  crossCuttingExpectations,
  publishStep,
  toolCallPhases,
} from './common.js';

const HOST = 'faceted-listing.yantra.test';
const RESULTS_URL = `${originOf('faceted-listing')}/new/results`;

/** The contract as the scripted agent declares it: a URL-shaped source, as models write one. */
const DECLARED = {
  deliverable: 'table',
  subject: 'new SUV listings',
  required_fields: ['seller', 'price', 'exterior color', 'interior color'],
  filters: [{ name: 'drivetrain', value: 'AWD' }],
  required_sources: [`https://www.${HOST}/new/results`],
} as const;

/** What the run must record: the same contract, normalized. */
const NORMALIZED = {
  deliverable: 'table',
  subject: 'new SUV listings',
  required_fields: ['seller', 'price', 'exterior color', 'interior color'],
  filters: [{ name: 'drivetrain', value: 'AWD' }],
  required_sources: [HOST],
  ranking: null,
  limit: null,
  notes: null,
};

const script: readonly ScriptStep[] = [
  {
    kind: 'parallel',
    steps: [
      { kind: 'call', tool: 'task_contract', label: 'contract', params: DECLARED },
      {
        kind: 'call',
        tool: 'web_search',
        label: 'discover',
        params: { query: `suv listings ${HOST}`, limit: 0 },
      },
    ],
  },
  {
    kind: 'call',
    tool: 'web_fetch',
    label: 'results',
    params: (ctx) => {
      const url = ctx.urlFromSearch(HOST);
      return url === null ? null : { url };
    },
  },
  publishStep('SUV listings', 'Read the listing page; see sources.'),
];

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'contract-json-validates-and-is-normalized',
    owner: 'FEAT-052',
    measure: (run) => ({
      valid: TaskContractRecord.safeParse(run.artifacts.contract).success,
      current: contractOf(run),
    }),
    target: equals({ valid: true, current: NORMALIZED }),
    note: 'G9: the declared contract is validated, normalized (hostname source), and persisted.',
  },
  {
    id: 'one-audited-call',
    owner: 'FEAT-052',
    measure: (run) => toolCallPhases(run, 'task_contract'),
    target: equals(['start', 'end']),
    note: 'Plan §10: the contract call has one tool-calls.jsonl start/end pair.',
  },
  {
    id: 'no-extra-turn',
    owner: 'FEAT-052',
    measure: (run) => (run.artifacts.usage as { agent?: { turns?: unknown } } | null)?.agent?.turns,
    // The same moves without the contract are three turns: search, fetch, publish.
    target: equals(3),
    note: 'Plan §12 item 3: declared in the same turn as the first search, it costs no turn.',
  },
  {
    id: 'no-missing-contract-notice',
    owner: 'FEAT-052',
    measure: (run) => contractNoticesOf(run),
    target: equals([]),
    note: 'G9: a run that declared a contract carries no missing-contract notice.',
  },
  {
    id: 'echoed-once',
    owner: 'FEAT-052',
    measure: (run) => contractEchoesOf(run).map((echo) => echo.revision),
    target: equals([1]),
    note: 'G9: the attended echo ("understood: …") is sent once per revision.',
  },
  {
    id: 'every-move-offered',
    owner: 'current',
    measure: (run) => run.unreachable,
    target: equals([]),
    note: 'The fetch follows a URL the discovery search offered.',
  },
];

export const contractDeclared: Scenario = {
  id: 'contract-declared',
  sites: ['faceted-listing'],
  command: 'research',
  goal: `List new AWD SUV listings with seller, price, and both colors. Use ${HOST}`,
  contract: {
    deliverable: 'table',
    requiredFields: ['seller', 'price', 'exteriorColor', 'interiorColor'],
    filters: [{ name: 'drivetrain', value: 'AWD' }],
    requiredSources: [HOST],
  },
  userLocation: null,
  serps: [{ match: 'suv', results: [{ url: RESULTS_URL, title: 'New SUV listings' }] }],
  script,
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
