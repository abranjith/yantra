import { DefaultSanitizer, type FillCensus } from '@yantra/core';
import {
  Brief,
  CONTRACT_REQUIREMENT_ID_PATTERN,
  type FillExemption,
  type TaskContractBody,
} from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { ActionLedger, type ActionLedgerInput } from '../../src/runtime/action-ledger.js';
import type { DeliveryConstraint } from '../../src/runtime/contract-delivery.js';
import {
  FulfillmentRecord,
  UNAVAILABLE_FILL,
  censusFillEvaluator,
  fillCoverage,
  evaluateFulfillment,
  fulfillmentSummary,
  toBriefRequirements,
  unmetPhrase,
  type FulfillmentInput,
} from '../../src/runtime/fulfillment.js';
import {
  NO_ACTION_TERMS,
  normalizeContract,
  type EffectiveActionTerms,
  type TaskContractParams,
} from '../../src/runtime/task-contract.js';

const sanitizer = new DefaultSanitizer();

function contract(overrides: Partial<TaskContractParams> = {}): TaskContractBody {
  const result = normalizeContract(
    {
      deliverable: 'actions',
      subject: 'the sign-up form',
      required_sources: ['forms.example.test'],
      ...overrides,
    },
    { sanitizer },
  );
  if (!result.isOk) throw new Error(`fixture rejected: ${result.error.cause}`);
  return result.value;
}

const VIEWPORT: EffectiveActionTerms = {
  ...NO_ACTION_TERMS,
  artifacts: [{ kind: 'screenshot', scope: 'viewport', declaredIn: 1 }],
};

/** A ledger whose epoch is set per entry by the caller's script. */
function ledger(script: readonly (ActionLedgerInput & { epoch?: number; host?: string })[]) {
  let next = { epoch: 1, host: 'forms.example.test' };
  const actions = new ActionLedger({
    nowIso: () => '2026-10-15T12:00:00.000Z',
    locate: () => next,
    sanitizer,
  });
  for (const { epoch, host, ...entry } of script) {
    next = { epoch: epoch ?? next.epoch, host: host ?? next.host };
    actions.record(entry as ActionLedgerInput);
  }
  return actions.entries();
}

const fill = {
  kind: 'fill_committed',
  tool: 'browser_fill_form',
  ref: 'e1',
  field: 'Email',
  groupKey: null,
  covers: 1,
} as const;
const capture = (
  scope: 'viewport' | 'full_page' | 'element',
  extra: { producer?: string; complete?: boolean; parts?: number } = {},
) =>
  ({
    kind: 'capture',
    scope,
    path: 'screenshots/capture-1-aaaaaaaaaaaa.png',
    sha256: 'a'.repeat(64),
    bytes: 10,
    producer: 'browser_capture',
    ...extra,
  }) as const;
const click = (submitClass: 'structural' | 'name' | null) =>
  ({ kind: 'click_executed', ref: 'e5', name: 'Next', submitClass }) as const;
const refused = { kind: 'submit_refused', ref: 'e6', name: 'Send', signal: 'structural' } as const;

function input(overrides: Partial<FulfillmentInput> = {}): FulfillmentInput {
  return {
    command: 'do',
    contract: contract(),
    terms: NO_ACTION_TERMS,
    deliverableGaps: [],
    constraints: [],
    ledger: ledger([fill]),
    claimedMet: null,
    captureGap: () => null,
    evaluateFill: UNAVAILABLE_FILL,
    ...overrides,
  };
}

function item(evaluation: ReturnType<typeof evaluateFulfillment>, id: string) {
  const found = evaluation.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

describe('@no-llm evaluateFulfillment — deliverable', () => {
  it('meets a table deliverable only when the content has no deliverable gap', () => {
    const table = contract({ deliverable: 'table', required_fields: ['price'] });
    expect(item(evaluateFulfillment(input({ contract: table })), 'deliverable').status).toBe('met');
    const gapped = evaluateFulfillment(
      input({ contract: table, deliverableGaps: ['price: no column was published'] }),
    );
    expect(item(gapped, 'deliverable')).toMatchObject({
      status: 'unmet',
      reason: 'price: no column was published',
    });
  });

  it('meets an answer or report unless nothing in it is cited from a required source', () => {
    for (const deliverable of ['answer', 'report'] as const) {
      const body = contract({ deliverable });
      expect(item(evaluateFulfillment(input({ contract: body })), 'deliverable').status).toBe(
        'met',
      );
      const off = evaluateFulfillment(
        input({
          contract: body,
          deliverableGaps: ['nothing in the answer is cited from forms.example.test'],
        }),
      );
      expect(item(off, 'deliverable').status).toBe('unmet');
    }
  });

  it('ignores table-shaped gaps for an answer', () => {
    const evaluation = evaluateFulfillment(
      input({ contract: contract({ deliverable: 'answer' }), deliverableGaps: ['x: not shown'] }),
    );
    expect(item(evaluation, 'deliverable').status).toBe('met');
  });

  it('meets actions when a fill or click happened on the required host', () => {
    expect(item(evaluateFulfillment(input()), 'deliverable').status).toBe('met');
    expect(
      item(evaluateFulfillment(input({ ledger: ledger([click(null)]) })), 'deliverable').status,
    ).toBe('met');
    expect(
      item(
        evaluateFulfillment(
          input({ ledger: ledger([{ ...fill, host: 'www.forms.example.test' }]) }),
        ),
        'deliverable',
      ).status,
    ).toBe('met');
  });

  it('leaves actions unmet with no committed action, or on the wrong host', () => {
    expect(
      item(
        evaluateFulfillment(input({ ledger: ledger([capture('viewport'), refused]) })),
        'deliverable',
      ),
    ).toMatchObject({ status: 'unmet', reason: 'no page action was recorded' });
    const wrong = evaluateFulfillment(input({ ledger: ledger([{ ...fill, host: 'other.test' }]) }));
    expect(item(wrong, 'deliverable')).toMatchObject({ status: 'unmet' });
    expect(item(wrong, 'deliverable').reason).toContain('other.test');
  });

  it('meets actions on any host when no source is required', () => {
    const anywhere = contract({ required_sources: [] });
    expect(
      item(
        evaluateFulfillment(
          input({ contract: anywhere, ledger: ledger([{ ...fill, host: 'x.test' }]) }),
        ),
        'deliverable',
      ).status,
    ).toBe('met');
  });
});

describe('@no-llm evaluateFulfillment — filters', () => {
  const withFilter = contract({
    deliverable: 'table',
    required_fields: ['price'],
    filters: [{ name: 'Condition', value: 'new' }],
  });
  const condition = (status: DeliveryConstraint['status'], cause?: string): DeliveryConstraint => ({
    name: 'condition',
    value: 'new',
    status,
    refs: ['S1'],
    ...(cause === undefined ? {} : { cause }),
  });

  it('maps verified to met, unverified to not confirmed, and violated to not met', () => {
    const at = (constraints: DeliveryConstraint[]) =>
      item(evaluateFulfillment(input({ contract: withFilter, constraints })), 'filter:condition');
    expect(at([condition('verified')])).toMatchObject({ status: 'met', label: 'Condition = new' });
    expect(at([condition('unverified', 'not reported by the agent')])).toMatchObject({
      status: 'unmet',
      reason: 'not confirmed (not reported by the agent)',
    });
    expect(at([condition('violated', 'source reports used')])).toMatchObject({
      status: 'unmet',
      reason: 'not met: source reports used',
    });
    expect(at([])).toMatchObject({ status: 'unmet', reason: 'not confirmed' });
  });

  it('gives filters whose names normalize alike distinct, valid ids', () => {
    const twins = contract({
      deliverable: 'answer',
      filters: [
        { name: 'drive-train', value: 'AWD' },
        { name: 'drive train', value: '4WD' },
      ],
    });
    const ids = evaluateFulfillment(input({ contract: twins })).items.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(CONTRACT_REQUIREMENT_ID_PATTERN.test(id)).toBe(true);
  });
});

describe('@no-llm evaluateFulfillment — artifacts', () => {
  const at = (overrides: Partial<FulfillmentInput>) =>
    item(
      evaluateFulfillment(input({ terms: VIEWPORT, ...overrides })),
      'artifact:screenshot:viewport',
    );

  it('meets a capture taken after the last action on the same document', () => {
    expect(at({ ledger: ledger([fill, capture('viewport')]) })).toMatchObject({ status: 'met' });
  });

  it('meets a viewport request with a full-page capture', () => {
    expect(at({ ledger: ledger([fill, capture('full_page')]) }).status).toBe('met');
  });

  it('does not meet full_page or element requests with a viewport capture', () => {
    for (const scope of ['full_page', 'element'] as const) {
      const evaluation = evaluateFulfillment(
        input({
          terms: { ...NO_ACTION_TERMS, artifacts: [{ kind: 'screenshot', scope, declaredIn: 1 }] },
          ledger: ledger([fill, capture('viewport')]),
        }),
      );
      expect(item(evaluation, `artifact:screenshot:${scope}`).status).toBe('unmet');
    }
  });

  it('meets any matching capture when the run committed no action', () => {
    expect(at({ ledger: ledger([capture('viewport')]) }).status).toBe('met');
  });

  it('is unmet when the capture came before the last fill', () => {
    expect(at({ ledger: ledger([capture('viewport'), fill]) })).toMatchObject({
      status: 'unmet',
      reason: 'captured before the last page action',
    });
  });

  it('is unmet when the capture is on a different document than the last action', () => {
    expect(
      at({
        ledger: ledger([
          { ...fill, epoch: 1 },
          { ...capture('viewport'), epoch: 2 },
        ]),
      }),
    ).toMatchObject({
      status: 'unmet',
      reason: 'captured on a different page than the last action',
    });
  });

  it('names the capability gap in plain words when nothing was captured', () => {
    expect(at({ captureGap: () => 'suppressed_by_flag' })).toMatchObject({
      status: 'unmet',
      reason: 'not captured (screenshots are off for this run (--no-screenshots))',
    });
    expect(at({ captureGap: () => 'no_browser' })).toMatchObject({
      reason: 'not captured (no browser was available)',
    });
    expect(at({})).toMatchObject({ status: 'unmet', reason: 'not captured' });
  });

  it('reads a suppressed screenshot on the Partial line as not captured with the flag named', () => {
    const evaluation = evaluateFulfillment(
      input({ terms: VIEWPORT, captureGap: () => 'suppressed_by_flag' }),
    );
    const unmet = evaluation.items.find((entry) => entry.status === 'unmet')!;

    expect(unmetPhrase(unmet)).toBe(
      'viewport screenshot not captured (screenshots are off for this run (--no-screenshots))',
    );
    expect(evaluation.met).toBeLessThan(evaluation.total);
  });

  it('ignores a Vision Assist image for a screenshot item (S7)', () => {
    expect(
      at({ ledger: ledger([fill, capture('viewport', { producer: 'browser_screenshot' })]) }),
    ).toMatchObject({ status: 'unmet', reason: 'not captured' });
  });

  it('meets with a browser_capture even when a Vision image came later', () => {
    expect(
      at({
        ledger: ledger([
          fill,
          capture('viewport'),
          capture('viewport', { producer: 'browser_screenshot' }),
        ]),
      }).status,
    ).toBe('met');
  });

  it('does not meet full_page with an incomplete set, but still meets viewport with it (S6)', () => {
    const terms: EffectiveActionTerms = {
      ...NO_ACTION_TERMS,
      artifacts: [
        { kind: 'screenshot', scope: 'viewport', declaredIn: 1 },
        { kind: 'screenshot', scope: 'full_page', declaredIn: 1 },
      ],
    };
    const evaluation = evaluateFulfillment(
      input({
        terms,
        ledger: ledger([fill, capture('full_page', { complete: false, parts: 6 })]),
      }),
    );

    expect(item(evaluation, 'artifact:screenshot:full_page')).toMatchObject({
      status: 'unmet',
      reason: 'capture_incomplete',
    });
    expect(item(evaluation, 'artifact:screenshot:viewport').status).toBe('met');
  });

  it('meets full_page once a complete set follows an incomplete one', () => {
    const terms: EffectiveActionTerms = {
      ...NO_ACTION_TERMS,
      artifacts: [{ kind: 'screenshot', scope: 'full_page', declaredIn: 1 }],
    };
    const evaluation = evaluateFulfillment(
      input({
        terms,
        ledger: ledger([
          fill,
          capture('full_page', { complete: false }),
          capture('full_page', { complete: true, parts: 3 }),
        ]),
      }),
    );

    expect(item(evaluation, 'artifact:screenshot:full_page').status).toBe('met');
  });

  it('treats an older capture entry without a complete flag as complete', () => {
    const terms: EffectiveActionTerms = {
      ...NO_ACTION_TERMS,
      artifacts: [{ kind: 'screenshot', scope: 'full_page', declaredIn: 1 }],
    };
    expect(
      item(
        evaluateFulfillment(input({ terms, ledger: ledger([fill, capture('full_page')]) })),
        'artifact:screenshot:full_page',
      ).status,
    ).toBe('met');
  });

  it('judges an incomplete full_page with no committed action as incomplete', () => {
    const terms: EffectiveActionTerms = {
      ...NO_ACTION_TERMS,
      artifacts: [{ kind: 'screenshot', scope: 'full_page', declaredIn: 1 }],
    };
    expect(
      item(
        evaluateFulfillment(
          input({ terms, ledger: ledger([capture('full_page', { complete: false })]) }),
        ),
        'artifact:screenshot:full_page',
      ),
    ).toMatchObject({ status: 'unmet', reason: 'capture_incomplete' });
  });

  it('keeps the revision that declared the artifact', () => {
    const terms: EffectiveActionTerms = {
      ...NO_ACTION_TERMS,
      artifacts: [{ kind: 'screenshot', scope: 'viewport', declaredIn: 2 }],
    };
    expect(
      item(evaluateFulfillment(input({ terms })), 'artifact:screenshot:viewport').declaredIn,
    ).toBe(2);
  });
});

describe('@no-llm evaluateFulfillment — effects.submit', () => {
  const forbidden: EffectiveActionTerms = {
    ...NO_ACTION_TERMS,
    submit: { value: 'forbidden', declaredIn: 1 },
  };
  const at = (script: Parameters<typeof ledger>[0]) =>
    item(
      evaluateFulfillment(input({ terms: forbidden, ledger: ledger(script) })),
      'effects.submit',
    );

  it('is met with no submit-class click, listing refused attempts', () => {
    expect(at([fill, click(null)])).toMatchObject({ status: 'met', reason: null });
    expect(at([fill, refused, refused])).toMatchObject({
      status: 'met',
      reason: '2 submit attempts refused',
    });
  });

  it('is unmet when a submit-class click executed', () => {
    expect(at([fill, click('structural')])).toMatchObject({
      status: 'unmet',
      reason: '1 submit-class click was executed',
    });
  });

  it('declares no submit item when submitting is allowed', () => {
    expect(evaluateFulfillment(input()).items.some((entry) => entry.id === 'effects.submit')).toBe(
      false,
    );
  });
});

describe('@no-llm evaluateFulfillment — fill, counts, and the disagreement notice', () => {
  const full: EffectiveActionTerms = {
    fill: { coverage: 'all_eligible', fields: [], declaredIn: 1 },
    artifacts: [{ kind: 'screenshot', scope: 'viewport', declaredIn: 1 }],
    submit: { value: 'forbidden', declaredIn: 1 },
  };

  it('never meets a fill without a census', () => {
    const evaluation = evaluateFulfillment(input({ terms: full }));
    expect(item(evaluation, 'fill')).toMatchObject({
      status: 'unmet',
      label: 'fill all eligible fields',
      reason: 'fields not counted (inventory_unavailable)',
    });
  });

  it('orders items and counts met over judged items', () => {
    const evaluation = evaluateFulfillment(input({ terms: full }));
    expect(evaluation.items.map((entry) => entry.id)).toEqual([
      'deliverable',
      'fill',
      'artifact:screenshot:viewport',
      'effects.submit',
    ]);
    expect(evaluation).toMatchObject({ met: 2, total: 4, contractDeclared: true });
  });

  it('raises exactly one fulfillment notice when the model claims met against evidence', () => {
    const evaluation = evaluateFulfillment(input({ terms: full, claimedMet: true }));
    expect(evaluation.disagreement).toMatchObject({ kind: 'contract_gap', source: 'fulfillment' });
    expect(evaluation.disagreement?.reason).toMatch(
      /^The agent reported every requirement met; evidence shows: /u,
    );
    expect(evaluation.disagreement?.reason).toContain('viewport screenshot not captured');
  });

  it('raises no notice when the model says unmet or omits fulfillment, and still computes counts', () => {
    for (const claimedMet of [false, null]) {
      const evaluation = evaluateFulfillment(input({ terms: full, claimedMet }));
      expect(evaluation.disagreement).toBeNull();
      expect(evaluation.total).toBe(4);
    }
  });

  it('raises no notice when the claim matches the evidence', () => {
    const evaluation = evaluateFulfillment(input({ claimedMet: true }));
    expect(evaluation).toMatchObject({ met: 1, total: 1, disagreement: null });
  });

  it('has no items and contractDeclared false without a contract', () => {
    expect(evaluateFulfillment(input({ contract: null, terms: full }))).toEqual({
      items: [],
      met: 0,
      total: 0,
      contractDeclared: false,
      disagreement: null,
    });
  });
});

describe('@no-llm fulfillment projections', () => {
  it('projects schema-valid Brief requirements', () => {
    const evaluation = evaluateFulfillment(
      input({
        contract: contract({ subject: `${'s'.repeat(200)}` }),
        terms: {
          fill: { coverage: 'all_eligible', fields: [], declaredIn: 1 },
          artifacts: [{ kind: 'screenshot', scope: 'element', declaredIn: 2 }],
          submit: { value: 'forbidden', declaredIn: 1 },
        },
      }),
    );
    const requirements = toBriefRequirements(evaluation);
    expect(requirements[0]?.label.length).toBeLessThanOrEqual(120);
    const brief = {
      brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      schema_version: '0.2',
      title: 'Form filled',
      overview: 'Done.',
      key_findings: [],
      sections: [],
      facets: null,
      sources: [],
      requirements,
      metadata: {
        search_provider: null,
        synthesis: 'llm',
        deterministic_fallback_used: false,
        coverage: null,
        freshness: null,
        usage: null,
        run_id: null,
      },
      notices: [],
    };
    expect(Brief.safeParse(brief).success).toBe(true);
    expect(requirements.find((entry) => entry.id === 'artifact:screenshot:element')).toMatchObject({
      declared_in: 2,
    });
  });

  it('phrases unmet items for a terminal line and summarizes the evaluation', () => {
    expect(
      unmetPhrase({
        id: 'fill',
        label: 'fill all eligible fields',
        reason: 'fields 10 of 48 filled',
      }),
    ).toBe('fields 10 of 48 filled');
    expect(
      unmetPhrase({
        id: 'artifact:screenshot:viewport',
        label: 'viewport screenshot',
        reason: 'not captured',
      }),
    ).toBe('viewport screenshot not captured');
    expect(unmetPhrase({ id: 'filter:x', label: 'x = y', reason: null })).toBe('x = y: not met');
    const evaluation = evaluateFulfillment(input({ terms: VIEWPORT }));
    expect(fulfillmentSummary(evaluation)).toBe('1 of 2 met; viewport screenshot not captured');
    expect(fulfillmentSummary(evaluateFulfillment(input({ contract: null })))).toBe(
      'no task contract was declared',
    );
  });

  it('holds the evaluation of the run’s publication', () => {
    const record = new FulfillmentRecord();
    expect(record.current()).toBeNull();
    const evaluation = evaluateFulfillment(input());
    record.record(evaluation);
    expect(record.current()).toBe(evaluation);
  });
});

describe('@no-llm censusFillEvaluator (FEAT-054 TASK-006)', () => {
  const ALL: NonNullable<EffectiveActionTerms['fill']> = {
    coverage: 'all_eligible',
    fields: [],
    declaredIn: 1,
  };

  function census(
    eligible: number,
    exempt: readonly FillExemption[] = [],
    overrides: Partial<FillCensus> = {},
  ): FillCensus {
    return {
      epoch: 1,
      host: 'forms.example.test',
      complete: true,
      controls: [
        ...Array.from({ length: eligible }, (_, index) => ({
          ref: `e${index + 1}`,
          groupKey: null,
          label: `Field ${index + 1}`,
          exemption: null,
        })),
        ...exempt.map((exemption, index) => ({
          ref: `x${index + 1}`,
          groupKey: null,
          label: `Exempt ${index + 1}`,
          exemption,
        })),
      ],
      ...overrides,
    };
  }

  const commits = (count: number, epoch = 1) =>
    ledger(
      Array.from({ length: count }, (_, index) => ({
        ...fill,
        ref: `e${index + 1}`,
        field: `Field ${index + 1}`,
        epoch,
      })),
    );

  it('is met when every eligible control was committed, and lists the exemptions', () => {
    const result = censusFillEvaluator(census(48, ['file_input', 'read_only', 'disabled']))(
      ALL,
      commits(48),
    );
    expect(result).toMatchObject({ status: 'met', reason: 'fields 48 of 48 filled' });
    expect(result.exemptions).toEqual([
      { label: 'Exempt 1', reason: 'file_input' },
      { label: 'Exempt 2', reason: 'read_only' },
      { label: 'Exempt 3', reason: 'disabled' },
    ]);
  });

  it('counts the committed controls when some are missing', () => {
    expect(censusFillEvaluator(census(48))(ALL, commits(10))).toMatchObject({
      status: 'unmet',
      reason: 'fields 10 of 48 filled',
    });
  });

  it('counts a radio group committed through one member once', () => {
    const grouped: FillCensus = {
      ...census(1),
      controls: [
        { ref: 'e1', groupKey: null, label: 'Name', exemption: null },
        { ref: 'r1', groupKey: 'Plan', label: 'Basic', exemption: null },
        { ref: 'r2', groupKey: 'Plan', label: 'Pro', exemption: null },
      ],
    };
    const committed = ledger([
      { ...fill, ref: 'e1' },
      { ...fill, ref: 'r2', groupKey: 'Plan' },
    ]);
    expect(censusFillEvaluator(grouped)(ALL, committed)).toMatchObject({
      status: 'met',
      reason: 'fields 2 of 2 filled',
    });
  });

  it('does not count a commit whose control the page replaced with a new ref', () => {
    const replaced = ledger([
      { ...fill, ref: 'e1' },
      { ...fill, ref: 'e99' },
    ]);
    expect(censusFillEvaluator(census(2))(ALL, replaced)).toMatchObject({
      status: 'unmet',
      reason: 'fields 1 of 2 filled',
    });
  });

  it('is unmet for an incomplete census, a census of another document, or none', () => {
    expect(censusFillEvaluator(census(2, [], { complete: false }))(ALL, commits(2))).toMatchObject({
      status: 'unmet',
      reason: 'fields not counted (inventory_incomplete)',
    });
    expect(censusFillEvaluator(census(2, [], { epoch: 2 }))(ALL, commits(2))).toMatchObject({
      status: 'unmet',
      reason: 'fields not counted (form_document_left)',
    });
    expect(censusFillEvaluator(null)(ALL, commits(2))).toMatchObject({
      status: 'unmet',
      reason: 'fields not counted (inventory_unavailable)',
    });
  });

  it('is unmet when the census found no eligible field', () => {
    expect(censusFillEvaluator(census(0, ['hidden']))(ALL, commits(0))).toMatchObject({
      status: 'unmet',
      reason: 'no eligible fields were found',
    });
  });

  it('bounds the exemption list to 20 with an overflow count, one entry per group', () => {
    const many = census(
      1,
      Array.from({ length: 25 }, () => 'hidden' as const),
    );
    const result = censusFillEvaluator(many)(ALL, commits(1));
    expect(result.exemptions).toHaveLength(20);
    expect(result.exemptOverflow).toBe(5);
    const grouped: FillCensus = {
      ...census(1),
      controls: [
        ...census(1).controls,
        { ref: 'x1', groupKey: 'Captcha', label: 'Code', exemption: 'human_verification' },
        { ref: 'x2', groupKey: 'Captcha', label: 'Audio', exemption: 'human_verification' },
      ],
    };
    expect(censusFillEvaluator(grouped)(ALL, commits(1)).exemptions).toHaveLength(1);
  });

  it('matches listed fields by name and names the ones not filled', () => {
    const listed: NonNullable<EffectiveActionTerms['fill']> = {
      coverage: 'listed',
      fields: ['First name', 'E-mail'],
      declaredIn: 1,
    };
    const committed = ledger([{ ...fill, field: 'first  NAME' }]);
    expect(censusFillEvaluator(null)(listed, committed)).toMatchObject({
      status: 'unmet',
      reason: 'fields 1 of 2 filled; not filled: E-mail',
    });
    expect(
      censusFillEvaluator(null)(
        listed,
        ledger([
          { ...fill, field: 'First name' },
          { ...fill, field: 'e mail' },
        ]),
      ),
    ).toMatchObject({ status: 'met', reason: 'fields 2 of 2 filled' });
  });
});

describe('@no-llm shared fill coverage', () => {
  it('counts both resolved range controls only on their current document', () => {
    const current: FillCensus = {
      epoch: 2,
      host: 'forms.example.test',
      complete: true,
      controls: ['from', 'to'].map((ref) => ({ ref, label: ref, groupKey: null, exemption: null })),
    };
    expect(
      fillCoverage(
        current,
        ledger([{ ...fill, epoch: 2, ref: 'from', covers: 2, coveredRefs: ['from', 'to'] }]),
      ),
    ).toMatchObject({ filled: 2, remaining: [] });
    expect(
      fillCoverage(
        current,
        ledger([{ ...fill, epoch: 1, ref: 'from', covers: 2, coveredRefs: ['from', 'to'] }]),
      ),
    ).toMatchObject({ filled: 0 });
    expect(
      fillCoverage(current, ledger([{ ...fill, epoch: 2, ref: 'from', covers: 2 }])),
    ).toMatchObject({ filled: 1 });
  });
  it('joins groups once, excludes exemptions and old epochs, and preserves order', () => {
    const census: FillCensus = {
      epoch: 2,
      host: 'forms.example.test',
      complete: false,
      controls: [
        { ref: 'e1', label: 'First', groupKey: null, exemption: null },
        { ref: 'e2', label: 'Choice', groupKey: 'radio:g', exemption: null },
        { ref: 'e3', label: 'Choice member', groupKey: 'radio:g', exemption: null },
        { ref: 'e4', label: 'Exempt', groupKey: null, exemption: 'disabled' },
        { ref: 'e5', label: 'Last', groupKey: null, exemption: null },
      ],
    };
    expect(
      fillCoverage(
        census,
        ledger([
          { ...fill, ref: 'e1', epoch: 1 },
          { ...fill, ref: 'e3', epoch: 2 },
        ]),
      ),
    ).toEqual({
      eligible: 3,
      filled: 1,
      complete: false,
      remaining: [
        { ref: 'e1', label: 'First', groupKey: null },
        { ref: 'e5', label: 'Last', groupKey: null },
      ],
    });
  });
});
