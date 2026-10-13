/**
 * `research-browse`: research reads a site the user named by bare hostname,
 * in a live browser, read-only (FEAT-052, plan G1).
 *
 * The goal names the host without a scheme; its root is attested by the goal
 * and nothing else. From there every navigation follows a link the page
 * offered.
 */

import type { ScriptStep } from '../agent/scripted-provider.js';
import { atLeast, equals, excludesAll, includesAll, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import {
  arrayOf,
  crossCuttingExpectations,
  fieldOf,
  publishStep,
  resultLabelled,
  scopeLineOf,
} from './common.js';

const HOST = 'faceted-listing.yantra.test';

const script: readonly ScriptStep[] = [
  { kind: 'call', tool: 'browser_navigate', label: 'home', params: { url: `http://${HOST}/` } },
  { kind: 'call', tool: 'browser_extract', label: 'home links', params: { kind: 'links' } },
  {
    kind: 'call',
    tool: 'browser_navigate',
    label: 'results',
    params: (ctx) => {
      const links = ctx.last('browser_extract')?.model as { links?: unknown } | undefined;
      const shopNew = Array.isArray(links?.links)
        ? (links.links as { text?: unknown; url?: unknown }[]).find(
            (link) => link.text === 'Shop new',
          )
        : undefined;
      return typeof shopNew?.url === 'string' ? { url: shopNew.url } : null;
    },
  },
  { kind: 'call', tool: 'browser_extract', label: 'records', params: { kind: 'records' } },
  publishStep('SUV listings', 'Read the listing in the browser; see sources.'),
];

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'read-only-browse-catalog',
    owner: 'FEAT-052',
    measure: (run) => run.registeredTools,
    target: includesAll([
      'browser_extract',
      'browser_navigate',
      'browser_observe',
      'task_contract',
    ]),
    note: 'G1: research registers read-only browsing by default.',
  },
  {
    id: 'no-click-or-fill',
    owner: 'FEAT-052',
    measure: (run) => run.registeredTools,
    target: excludesAll(['browser_click', 'browser_fill_element', 'browser_fill_form']),
    note: 'Plan §8: research browsing never clicks or fills.',
  },
  {
    id: 'bare-host-root-is-goal-attested',
    owner: 'FEAT-052',
    measure: (run) => {
      const home = resultLabelled(run, 'home');
      const provenance = (home?.details as { provenance?: { kind?: unknown } } | undefined)
        ?.provenance;
      return { status: home?.status ?? null, provenance: provenance?.kind ?? null };
    },
    target: equals({ status: 'ok', provenance: 'goal' }),
    note: 'TASK-006: a hostname the user typed bare is reachable at its root, attested by the goal.',
  },
  {
    id: 'extract-yields-records',
    owner: 'FEAT-052',
    measure: (run) => arrayOf(resultLabelled(run, 'records'), 'records')?.length ?? 0,
    target: atLeast(1),
    note: 'G1: the live page reads as records (FEAT-051 owns their fields).',
  },
  {
    id: 'scope-line-says-read-only',
    owner: 'FEAT-052',
    measure: (run) => scopeLineOf(run),
    target: equals(
      'Scope: web search, page reading, and read-only browsing (navigate, observe, extract); ' +
        'this run cannot click or fill forms — if the goal needs that, report it and name ' +
        '`yantra do` as the next step.',
    ),
    note: 'G1: the per-run scope line states what the catalog can do.',
  },
  {
    id: 'every-move-offered',
    owner: 'current',
    measure: (run) => ({
      unreachable: run.unreachable,
      final: fieldOf(resultLabelled(run, 'publish'), 'published'),
    }),
    target: equals({ unreachable: [], final: true }),
    note: 'Every navigation after the root follows a link the page offered.',
  },
];

export const researchBrowse: Scenario = {
  id: 'research-browse',
  sites: ['faceted-listing'],
  command: 'research',
  goal: `List the new listings with seller and price. Use ${HOST}`,
  contract: {
    deliverable: 'table',
    requiredFields: ['seller', 'price'],
    filters: [],
    requiredSources: [HOST],
  },
  userLocation: null,
  serps: [],
  script,
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
