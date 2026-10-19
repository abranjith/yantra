/** Deterministic acceptance scripts use only observations and public engineered moves. */
import { layoutMatrix } from '@yantra/test-helpers/layout-matrix';

import type { ScriptContext, ScriptStep } from '../agent/scripted-provider.js';
import { equals, satisfies, type Expectation } from '../expectations.js';
import { BENCHMARK_RULES } from '../fixtures/form-lab.js';
import { protectedDigest } from '../fixtures/form-state.js';
import type { Scenario } from '../scenario.js';

import { crossCuttingExpectations } from './common.js';
import { withActionGate } from './do-gate-common.js';

interface OfferedControl {
  ref: string;
  name: string;
  field?: { origin?: string };
}
interface OfferedObservation {
  interactables?: OfferedControl[];
  inventory?: { continue_after?: string };
}
function observationOf(ctx: ScriptContext): OfferedObservation {
  for (const result of [...ctx.results].reverse()) {
    const model = result.model as {
      observation?: OfferedObservation;
      interactables?: OfferedControl[];
    } | null;
    const observation = model?.observation ?? model;
    if (observation?.interactables !== undefined) return observation;
  }
  return {};
}
function fill(fields: readonly (readonly [string, string])[], label = 'fill'): ScriptStep {
  return {
    kind: 'call',
    tool: 'browser_fill_form',
    label,
    params: { fields: fields.map(([field, value]) => ({ field, value })) },
  };
}
function click(name: string): ScriptStep {
  return {
    kind: 'call',
    tool: 'browser_click',
    label: 'replace',
    params: (ctx) => {
      const ref = observationOf(ctx).interactables?.find((entry) => entry.name === name)?.ref;
      return ref === undefined ? null : { ref };
    },
  };
}

/** One isolated form run with its own truth, scopes and acceptance checks. */
export function makeGateScenario(id: string, page: string): Scenario {
  const url = `https://form-lab.yantra.test/${page}`;
  const scope = page === 'over-cap' ? 'full_page' : 'viewport';
  const intended: Record<string, string | boolean> = {};
  const script: ScriptStep[] = [
    {
      kind: 'call',
      tool: 'task_contract',
      params: {
        deliverable: 'actions',
        subject: 'the form',
        fill: { coverage: 'all_eligible' },
        artifacts: [{ kind: 'screenshot', scope }],
        effects: { submit: 'forbidden' },
      },
    },
    { kind: 'call', tool: 'browser_navigate', label: 'open', params: { url } },
  ];
  const extra: Expectation[] = [];
  let canaries: readonly string[] | undefined;
  let goal = `Fill every field of the form at ${url} with suitable test data, then take a ${scope === 'full_page' ? 'full-page' : 'viewport'} screenshot. Do not submit the form.`;
  if (page === 'css-order-grid') {
    script.push(
      fill([
        ['Family name', 'River'],
        ['Given name', 'Avery'],
      ]),
    );
    Object.assign(intended, { family: 'River', given: 'Avery' });
  } else if (page === 'repeated-sections') {
    script.push(
      fill([['City', 'Ambiguous']], 'ambiguous'),
      fill([
        ['Billing City', 'Riverton'],
        ['Shipping City', 'Lakeside'],
        ['Office Region', 'North'],
      ]),
    );
    Object.assign(intended, {
      'billing-city': 'Riverton',
      'shipping-city': 'Lakeside',
      region: 'North',
    });
    extra.push({
      id: 'identity.ambiguity',
      owner: 'FEAT-060',
      note: 'Bare City offers both sections before section-qualified resolution.',
      measure: (run) => run.toolResults.find((result) => result.label === 'ambiguous')?.modelText,
      target: satisfies(
        'names both Billing and Shipping candidates',
        (value) =>
          typeof value === 'string' && value.includes('Billing') && value.includes('Shipping'),
      ),
    });
  } else if (page === 'no-evidence') {
    script.push(fill([['Unnamed field', 'Synthetic']], 'missing label'), {
      kind: 'call',
      tool: 'browser_fill_form',
      label: 'fill refs',
      params: (ctx) => {
        const refs = (observationOf(ctx).interactables ?? []).filter(
          (entry) => entry.field?.origin === 'none',
        );
        return refs.length === 0
          ? null
          : { fields: refs.map((entry) => ({ field: entry.ref, value: 'Synthetic' })) };
      },
    });
    Object.assign(intended, { a: 'Synthetic', b: 'Synthetic' });
    extra.push({
      id: 'identity.no-guess',
      owner: 'FEAT-060',
      note: 'Unlabeled actions retain refs and explicitly absent labels.',
      measure: (run) =>
        (
          run.artifacts.brief as { actions?: { kind: string; label_origin?: string }[] } | null
        )?.actions
          ?.filter((action) => action.kind === 'fill')
          .map((action) => action.label_origin),
      target: equals(['none', 'none']),
    });
  } else if (page === 'over-cap') {
    script.push({
      kind: 'call',
      tool: 'browser_observe',
      label: 'window',
      params: { kinds: ['field'] },
    });
    for (let index = 0; index < 3; index++)
      script.push({
        kind: 'call',
        tool: 'browser_observe',
        label: 'next window',
        when: (ctx) => observationOf(ctx).inventory?.continue_after !== undefined,
        params: (ctx) => ({
          after: observationOf(ctx).inventory!.continue_after!,
          kinds: ['field'],
        }),
      });
    const fixture = layoutMatrix.find((candidate) => candidate.id === 'over-cap')!;
    for (let start = 0; start < fixture.controls.length; start += 10)
      script.push(
        fill(
          fixture.controls
            .slice(start, start + 10)
            .map((control, index) => [
              control.expect.kind === 'label' ? control.expect.query : '',
              `Sample${start + index}`,
            ]),
          'fill batch',
        ),
      );
    fixture.controls.forEach((control, index) => {
      intended[control.key] = `Sample${index}`;
    });
    extra.push({
      id: 'inventory.continuation',
      owner: 'FEAT-060',
      note: 'Above-cap inventory offers continuation and the script follows it.',
      measure: (run) =>
        run.toolResults.some(
          (result) =>
            result.label === 'window' && JSON.stringify(result.model).includes('continue_after'),
        ) && run.toolResults.some((result) => result.label === 'next window'),
      target: equals(true),
    });
  } else if (page === 'mixed-form') {
    const password = 'FEAT060-protected-canary';
    canaries = [password];
    goal += ` Use @password{${password}} for the Password field.`;
    script.push(
      fill([
        ['First name', 'Avery'],
        ['Family name', 'River'],
        ['Email', 'avery@example.test'],
        ['Region', 'North'],
        ['Comments', 'Synthetic notes'],
        ['Password', '{{user:password:1}}'],
      ]),
    );
    Object.assign(intended, {
      first: 'Avery',
      family: 'River',
      email: 'avery@example.test',
      region: 'North',
      comments: 'Synthetic notes',
      password: protectedDigest(password),
    });
    extra.push({
      id: 'protected.withheld',
      owner: 'FEAT-060',
      note: 'Protected synthetic data returns an exact in-page verdict and no value.',
      measure: (run) =>
        JSON.stringify(run.toolResults.find((result) => result.label === 'fill')?.model).includes(
          '"verdict":"exact"',
        ),
      target: equals(true),
    });
  } else if (page === 'recovery-groups') {
    script.push(
      fill(
        [
          ['Name', 'Avery'],
          ['Units', '99'],
          ['Email', 'before@example.test'],
          ['Check-in', '2026-09-06'],
          ['Check-out', '2026-10-02'],
        ],
        'first batch',
      ),
      click('Replace email'),
      fill(
        [
          ['Units', '8'],
          ['Email', 'after@example.test'],
        ],
        'recover batch',
      ),
    );
    Object.assign(intended, {
      name: 'Avery',
      units: '8',
      email: 'after@example.test',
      from: 'Sep 6, 2026',
      to: 'Oct 2, 2026',
    });
    extra.push({
      id: 'recovery.minimal',
      owner: 'FEAT-060',
      note: 'Only refused/replaced controls are resent, and the date pair is one entry.',
      measure: (run) => {
        const recovery = run.toolResults.find((result) => result.label === 'recover batch');
        const first = run.toolResults.find((result) => result.label === 'first batch');
        return {
          recovery: recovery?.params.fields,
          pair: (
            first?.details as { applied?: { covers?: string[] }[] } | undefined
          )?.applied?.some((entry) => entry.covers?.length === 2),
        };
      },
      target: equals({
        recovery: [
          { field: 'Units', value: '8' },
          { field: 'Email', value: 'after@example.test' },
        ],
        pair: true,
      }),
    });
  } else if (page === 'cite-actions') {
    script.push({
      kind: 'call',
      tool: 'browser_extract',
      label: 'prefill page',
      params: { kind: 'content' },
    });
    script.push(
      fill([
        ['First name', 'Avery'],
        ['Email', 'avery@example.test'],
      ]),
    );
    Object.assign(intended, { first: 'Avery', email: 'avery@example.test' });
  } else {
    script.push(
      fill([
        ['First name', 'Avery'],
        ['Last name', 'River'],
      ]),
    );
    Object.assign(intended, { first: 'Avery', last: 'River' });
  }
  script.push({ kind: 'call', tool: 'browser_capture', label: 'capture', params: { scope } });
  if (page === 'cite-actions') {
    const citeSource = id === 'do-gate-cite-source-for-fill';
    script.push({
      kind: 'call',
      tool: 'result_publish',
      label: 'publish',
      params: {
        brief: {
          title: 'Evidence form',
          overview: 'Completed the form without submitting it.',
          key_findings: [
            `Filled First name with Avery [${citeSource ? 'S1' : 'A1'}]`,
            'Filled Email with avery@example.test [A2]',
            'Captured the page [A3]',
            'Evidence form [S1]',
          ],
        },
      },
    });
    extra.push({
      id: 'citation.separation',
      owner: 'FEAT-060',
      note: 'Pages cannot establish a commit; actions link to their audited calls.',
      measure: (run) => {
        const brief = run.artifacts.brief as {
          actions?: { id: string; call_id: string | null }[];
          notices?: { kind: string }[];
          sources?: { cited?: boolean }[];
        };
        const actions = brief.actions ?? [];
        const ends = (run.artifacts.toolCalls?.lines ?? []) as {
          phase: string;
          call_id: string;
          actions?: string[];
        }[];
        return {
          flagged:
            brief.notices?.filter((notice) => notice.kind === 'uncited_claim_flagged').length ?? 0,
          actions: actions.length,
          paired: actions.every((action) =>
            ends.some(
              (entry) =>
                entry.phase === 'end' &&
                entry.call_id === action.call_id &&
                entry.actions?.includes(action.id),
            ),
          ),
          citedSources: brief.sources?.filter((source) => source.cited !== false).length,
        };
      },
      target: equals({
        flagged: citeSource ? 1 : 0,
        actions: citeSource ? 2 : 3,
        paired: true,
        citedSources: 1,
      }),
    });
  } else {
    script.push({
      kind: 'call',
      tool: 'result_publish',
      label: 'publish',
      params: {
        brief: {
          title: 'Form completed',
          overview: 'Completed the form without submitting it.',
          ...(page === 'no-evidence'
            ? { key_findings: ['Filled field [A1]', 'Filled field [A2]'] }
            : {}),
        },
      },
    });
  }
  if (id === 'do-gate-promote-replay')
    extra.push({
      id: 'promotion.replay',
      owner: 'FEAT-060',
      note: 'A fulfilled structural fill promotes without the screenshot and replays the same controls with zero LLM.',
      measure: (run) => {
        const workflow = run.replay?.workflow as
          | { steps?: { verb: string; field_label_origin?: string }[] }
          | undefined;
        const steps = workflow?.steps?.filter((step) => step.verb === 'fill_element') ?? [];
        return {
          saved: run.outcome.kind === 'published' ? run.outcome.promotion : null,
          outcome: run.replay?.outcome,
          controls: run.replay?.formState['table-label-cell']?.controls,
          identities: steps.map((step) => step.field_label_origin),
        };
      },
      target: satisfies(
        'saved with omitted viewport capture and structurally identified replay values match',
        (value) => {
          const result = value as {
            saved?: { saved?: boolean; omitted?: string[] };
            outcome?: string;
            controls?: { first?: { value?: string }; last?: { value?: string } };
            identities?: string[];
          };
          return (
            result.saved?.saved === true &&
            result.saved.omitted?.includes('viewport screenshot') === true &&
            result.outcome === 'success' &&
            result.controls?.first?.value === 'Avery' &&
            result.controls.last?.value === 'River' &&
            result.identities?.length === 2 &&
            result.identities.every((origin) => origin === 'structural')
          );
        },
      ),
    });
  return withActionGate({
    id,
    sites: ['form-lab'],
    command: 'do',
    goal,
    contract: {
      deliverable: 'actions',
      requiredFields: [],
      filters: [],
      requiredSources: [],
      actionTruth: {
        page,
        rules: BENCHMARK_RULES[page]!,
        intended,
        artifacts: [scope],
        submit: 'forbidden',
      },
    },
    userLocation: null,
    serps: [],
    script,
    expectations: [...crossCuttingExpectations(), ...extra],
    tiers: ['deterministic'],
    truth: () => [],
    ...(page === 'over-cap' ? { timeoutMs: 240000 } : {}),
    ...(canaries === undefined ? {} : { canaries }),
    ...(id === 'do-gate-promote-replay'
      ? { saveAs: 'gate-structural-form', timeoutMs: 60000 }
      : {}),
  });
}
