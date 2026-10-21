import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultSanitizer,
  type AgentBrowserController,
  type ConfirmationGateway,
  type ConfirmationOutcome,
  type SubmitFacts,
} from '@yantra/core';
import type { ConfirmationRequestType as ConfirmationRequest } from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserClickSpec } from '../../../../src/adapters/pi/tools/browser-click.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { RunServices } from '../../../../src/runtime/run-services.js';
import {
  TaskContractStore,
  normalizeContract,
  type TaskContractParams,
} from '../../../../src/runtime/task-contract.js';

import { buildServices, recordingRuntimeLogger } from './test-support.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The submit-class facts of each fixture control, as `submitFacts` reads them. */
const CONTROLS: Readonly<Record<string, { readonly name: string; readonly facts: SubmitFacts }>> = {
  e1: { name: 'Send now', facts: { tag: 'button', resolvedType: 'submit', hasFormOwner: true } },
  e2: {
    name: 'Add another',
    facts: { tag: 'button', resolvedType: 'button', hasFormOwner: true },
  },
  e3: { name: 'Submit a ticket', facts: { tag: 'a', resolvedType: null, hasFormOwner: false } },
  e4: {
    name: 'Submit order',
    facts: { tag: 'button', resolvedType: 'button', hasFormOwner: false },
  },
};

/** A controller double whose `click` count is the fixture's submission counter. */
function formController() {
  const landed = { url: 'https://forms.example.test/signup', title: 'Sign up' };
  return {
    navigate: vi.fn().mockResolvedValue(landed),
    observe: vi.fn().mockResolvedValue({
      url: landed.url,
      title: landed.title,
      digest: '',
      digestUnchanged: false,
      interactables: [],
    }),
    click: vi.fn().mockResolvedValue(landed),
    adoptPopup: vi.fn().mockResolvedValue(null),
    url: vi.fn().mockReturnValue(landed.url),
    host: vi.fn().mockReturnValue('forms.example.test'),
    describeRef: vi.fn((ref: string) => {
      const control = CONTROLS[ref];
      return control === undefined ? undefined : { ref, role: 'button', name: control.name };
    }),
    submitFacts: vi.fn((ref: string) => Promise.resolve(CONTROLS[ref]?.facts ?? null)),
    locatorFor: vi.fn().mockResolvedValue([]),
    beginToolCall: vi.fn(),
  };
}

/** A gateway that records every request and denies it. */
function recordingGateway(): ConfirmationGateway & { readonly requests: ConfirmationRequest[] } {
  const requests: ConfirmationRequest[] = [];
  return {
    requests,
    request: (req: ConfirmationRequest): Promise<ConfirmationOutcome> => {
      requests.push(req);
      return Promise.resolve({
        confirmation_id: req.confirmation_id,
        decision: 'denied',
        decided_at: '2026-10-15T12:00:00.000Z',
        decided_by: 'user_interactive',
      });
    },
  };
}

async function setup(
  submit: 'forbidden' | 'allowed' | 'undeclared',
  options: { readonly requiredToPublish?: boolean } = {},
): Promise<{
  readonly services: RunServices;
  readonly controller: ReturnType<typeof formController>;
  readonly gateway: ReturnType<typeof recordingGateway>;
  readonly logger: ReturnType<typeof recordingRuntimeLogger>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-click-policy-'));
  dirs.push(dir);
  const contract = new TaskContractStore({
    runId: 'r',
    runDir: dir,
    command: 'do',
    required: true,
    ...(options.requiredToPublish === undefined
      ? {}
      : { requiredToPublish: options.requiredToPublish }),
  });
  if (submit !== 'undeclared') {
    const params: TaskContractParams = {
      deliverable: 'actions',
      subject: 'the sign-up form',
      effects: { submit },
    };
    const body = normalizeContract(params, { sanitizer: new DefaultSanitizer() });
    if (!body.isOk) throw new Error('fixture contract rejected');
    await contract.declare(body.value, '2026-10-15T12:00:00.000Z');
  }
  const controller = formController();
  const gateway = recordingGateway();
  const logger = recordingRuntimeLogger();
  const base = buildServices({
    runDir: dir,
    contract,
    runtimeLogger: logger,
    domain: {
      browser: {
        controller: controller as unknown as AgentBrowserController,
        ethics: { check: () => Promise.resolve() },
        secretResolver: null,
        secretHosts: () => Promise.resolve([]),
        captureThresholdBytes: 1024,
      },
    },
  });
  return {
    services: { ...base, confirmation: { gateway, store: null } },
    controller,
    gateway,
    logger,
  };
}

async function click(services: RunServices, ref: string) {
  return wrapTool(browserClickSpec(services), services).execute({ ref }, undefined);
}

describe('@no-llm browser_click under effects.submit: forbidden (FEAT-054)', () => {
  it('refuses a structural submit button before any prompt, and nothing is clicked', async () => {
    const { services, controller, gateway } = await setup('forbidden');

    const result = await click(services, 'e1');

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('SUBMIT_FORBIDDEN');
    expect(result.retryable).toBe(false);
    expect(result.modelText).toMatch(/would submit the form/u);
    expect(result.modelText).toMatch(/result_publish/u);
    expect(gateway.requests).toHaveLength(0);
    expect(controller.click).not.toHaveBeenCalled();
  });

  it('refuses a control whose name reads as a submit action, with the name cause', async () => {
    const { services, controller, gateway } = await setup('forbidden');

    const result = await click(services, 'e3');

    expect(result.error_code).toBe('SUBMIT_FORBIDDEN');
    expect(result.modelText).toMatch(/reads as a submit action/u);
    expect(gateway.requests).toHaveLength(0);
    expect(controller.click).not.toHaveBeenCalled();
  });

  it('clicks a non-submit button normally', async () => {
    const { services, controller } = await setup('forbidden');

    const result = await click(services, 'e2');

    expect(result.status).toBe('ok');
    expect(controller.click).toHaveBeenCalledOnce();
  });

  it('logs one submit_refused line with the signal and host only', async () => {
    const { services, logger } = await setup('forbidden');

    await click(services, 'e1');

    expect(logger.lines.filter((line) => line.event === 'submit_refused')).toEqual([
      {
        level: 'info',
        schema_version: 1,
        event: 'submit_refused',
        signal: 'structural',
        host: 'forms.example.test',
      },
    ]);
    expect(JSON.stringify(logger.lines)).not.toContain('Send now');
  });

  it('keeps refusing after a later revision says submit: allowed', async () => {
    const { services, controller } = await setup('forbidden');
    const looser = normalizeContract(
      { deliverable: 'actions', subject: 'the form', effects: { submit: 'allowed' } },
      { sanitizer: new DefaultSanitizer() },
    );
    if (!looser.isOk) throw new Error('fixture rejected');
    await services.contract.declare(looser.value, '2026-10-15T12:00:05.000Z');

    const result = await click(services, 'e1');

    expect(result.error_code).toBe('SUBMIT_FORBIDDEN');
    expect(controller.click).not.toHaveBeenCalled();
  });
});

describe('@no-llm browser_click when submitting is allowed', () => {
  it.each(['allowed', 'undeclared'] as const)(
    'keeps the existing confirmation path unchanged (%s) and never reads submit facts',
    async (submit) => {
      const { services, controller, gateway } = await setup(submit);

      const result = await click(services, 'e4');

      expect(result.status).toBe('denied');
      expect(controller.click).not.toHaveBeenCalled();
      expect(controller.submitFacts).not.toHaveBeenCalled();
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]).toMatchObject({
        action_kind: 'click',
        host: 'forms.example.test',
        description: 'Click "Submit order".',
        consequence: 'hard_to_reverse',
      });
    },
  );

  it('clicks a structural submit button without a prompt when its name is neutral', async () => {
    const { services, controller, gateway } = await setup('allowed');

    const result = await click(services, 'e1');

    expect(result.status).toBe('ok');
    expect(controller.click).toHaveBeenCalledOnce();
    expect(gateway.requests).toHaveLength(0);
  });
});

describe('@no-llm browser_click records verified outcomes in the action ledger (FEAT-054)', () => {
  it('records an executed click with its submit class, reading the facts once', async () => {
    const { services, controller } = await setup('allowed');

    await click(services, 'e1');

    expect(controller.submitFacts).toHaveBeenCalledOnce();
    expect(services.actionLedger.entries()).toEqual([
      expect.objectContaining({
        kind: 'click_executed',
        ref: 'e1',
        name: 'Send now',
        submitClass: 'structural',
        host: 'forms.example.test',
      }),
    ]);
  });

  it('records a refusal, and the refused click is not a committed action', async () => {
    const { services } = await setup('forbidden');

    await click(services, 'e1');

    expect(services.actionLedger.entries()).toEqual([
      expect.objectContaining({ kind: 'submit_refused', ref: 'e1', signal: 'structural' }),
    ]);
    expect(services.actionLedger.lastCommittedAction()).toBeNull();
  });

  it('records nothing for a click that fails', async () => {
    const { services, controller } = await setup('allowed');
    controller.click.mockRejectedValue(new Error('click failed'));

    const result = await click(services, 'e2');

    expect(result.status).toBe('error');
    expect(services.actionLedger.entries()).toEqual([]);
  });
});

describe('@no-llm browser_click before a contract in do (REV-003)', () => {
  it('refuses a structural submit button before any contract, with no prompt and no click', async () => {
    const { services, controller, gateway } = await setup('undeclared', {
      requiredToPublish: true,
    });

    const result = await click(services, 'e1');

    expect(result.error_code).toBe('CONTRACT_REQUIRED');
    expect(result.retryable).toBe(true);
    expect((JSON.parse(result.modelText) as { message: string }).message).toMatch(
      /Call task_contract first/u,
    );
    expect(controller.click).not.toHaveBeenCalled();
    expect(controller.submitFacts).not.toHaveBeenCalled();
    expect(gateway.requests).toEqual([]);
    expect(services.actionLedger.entries()).toEqual([]);
  });

  it('refuses an ordinary button too: the gate is about ordering, not the target', async () => {
    const { services, controller } = await setup('undeclared', { requiredToPublish: true });

    const result = await click(services, 'e2');

    expect(result.error_code).toBe('CONTRACT_REQUIRED');
    expect(controller.click).not.toHaveBeenCalled();
  });

  it('applies the declared effects once a contract exists: a forbidden submit is then refused by the policy', async () => {
    const { services, controller } = await setup('forbidden', { requiredToPublish: true });

    expect((await click(services, 'e1')).error_code).toBe('SUBMIT_FORBIDDEN');
    const ordinary = await click(services, 'e2');

    expect(ordinary.status).toBe('ok');
    expect(controller.click).toHaveBeenCalledOnce();
  });

  it('leaves a run whose result is not judged against a contract unchanged', async () => {
    const { services, controller } = await setup('undeclared', { requiredToPublish: false });

    const result = await click(services, 'e2');

    expect(result.status).toBe('ok');
    expect(controller.click).toHaveBeenCalledOnce();
  });
});
