import type { RecordingDraft, CapturedAction } from '@yantra/protocol';
import type {
  WorkflowFile,
  WorkflowStep,
  LocatorCandidate,
  ParamDeclaration,
} from '@yantra/protocol';
import type { SecurityClass, SecurityScope } from '@yantra/protocol';
import { RoleEnum } from '@yantra/protocol';

import {
  suggestLocatorName,
  suggestRequiresConfirmation,
  suggestValuePromotion,
} from './suggest.js';

export type ValuePromotion = 'literal' | 'param' | 'secret' | 'output' | null;

export type AnnotateState =
  | { kind: 'reviewing'; index: number }
  | { kind: 'preview' }
  | { kind: 'confirm' }
  | { kind: 'saved' }
  | { kind: 'cancelled' };

export interface AnnotateDecision {
  draftActionId: string;
  action: 'keep' | 'skip';
  locatorName: string | null;
  valuePromotion: ValuePromotion;
  paramOrSecretKey: string | null;
  scopeOverride: SecurityScope | null;
  requiresConfirmation: boolean;
}

export interface AnnotateView {
  index: number;
  total: number;
  capturedAction: CapturedAction;
  suggestedLocatorName: string | null;
  suggestedValuePromotion: ValuePromotion;
  candidateSummary: string[];
}

interface RawCandidate {
  kind: string;
  role?: string;
  name?: string;
  value?: string;
}

function candidateSummaryFromAction(action: CapturedAction): string[] {
  if (action.kind !== 'click' && action.kind !== 'fill') return [];

  return action.candidate_chain.slice(0, 3).map((c) => {
    const cand = c.candidate as RawCandidate;
    switch (cand.kind) {
      case 'role':
        return `role=${cand.role ?? ''} name="${cand.name ?? ''}"`;
      case 'testid':
        return `testid="${cand.value ?? ''}"`;
      case 'label':
        return `label="${cand.value ?? ''}"`;
      case 'placeholder':
        return `placeholder="${cand.value ?? ''}"`;
      case 'css':
        return `css="${cand.value ?? ''}"`;
      case 'xpath':
        return `xpath="${cand.value ?? ''}"`;
      default:
        return cand.kind;
    }
  });
}

function isAnnotatable(action: CapturedAction): boolean {
  return action.kind === 'click' || action.kind === 'fill' || action.kind === 'navigate';
}

function buildLocatorCandidates(action: {
  candidate_chain: { candidate: RawCandidate }[];
}): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];

  for (const ranked of action.candidate_chain.slice(0, 5)) {
    const cand = ranked.candidate;

    if (cand.kind === 'role') {
      if (!cand.name) continue;
      const roleResult = RoleEnum.safeParse(cand.role);
      if (!roleResult.success) continue;
      candidates.push({ kind: 'role', role: roleResult.data, name: cand.name });
    } else if (cand.kind === 'testid') {
      if (!cand.value) continue;
      candidates.push({ kind: 'testid', value: cand.value });
    } else if (cand.kind === 'label') {
      if (!cand.value) continue;
      candidates.push({ kind: 'label', value: cand.value });
    } else if (cand.kind === 'placeholder') {
      if (!cand.value) continue;
      candidates.push({ kind: 'placeholder', value: cand.value });
    } else if (cand.kind === 'css') {
      if (!cand.value) continue;
      candidates.push({ kind: 'css', value: cand.value });
    } else if (cand.kind === 'xpath') {
      if (!cand.value) continue;
      candidates.push({ kind: 'xpath', value: cand.value });
    }
  }

  return candidates;
}

export class AnnotateSession {
  private state: AnnotateState = { kind: 'reviewing', index: 0 };
  private decisions: AnnotateDecision[] = [];
  private readonly annotatableActions: CapturedAction[];

  constructor(
    private readonly draft: RecordingDraft,
    public readonly workflowName: string,
    public readonly securityClass: SecurityClass,
  ) {
    this.annotatableActions = draft.actions.filter(isAnnotatable);
  }

  getState(): AnnotateState {
    return this.state;
  }

  current(): AnnotateView | null {
    if (this.state.kind !== 'reviewing') return null;
    const index = this.state.index;
    const action = this.annotatableActions[index];
    if (!action) return null;

    return {
      index,
      total: this.annotatableActions.length,
      capturedAction: action,
      suggestedLocatorName: suggestLocatorName(action),
      suggestedValuePromotion: suggestValuePromotion(action),
      candidateSummary: candidateSummaryFromAction(action),
    };
  }

  applyDecision(decision: AnnotateDecision): void {
    if (this.state.kind !== 'reviewing') return;
    const index = this.state.index;
    this.decisions[index] = decision;
  }

  next(): void {
    if (this.state.kind !== 'reviewing') return;
    const nextIndex = this.state.index + 1;
    if (nextIndex >= this.annotatableActions.length) {
      this.state = { kind: 'preview' };
    } else {
      this.state = { kind: 'reviewing', index: nextIndex };
    }
  }

  back(): void {
    if (this.state.kind === 'reviewing' && this.state.index > 0) {
      this.state = { kind: 'reviewing', index: this.state.index - 1 };
    } else if (this.state.kind === 'preview') {
      const lastIndex = this.annotatableActions.length - 1;
      this.state = { kind: 'reviewing', index: lastIndex };
    }
  }

  acceptAll(): void {
    if (this.state.kind !== 'reviewing') return;
    const startIndex = this.state.index;
    for (let i = startIndex; i < this.annotatableActions.length; i++) {
      if (!this.decisions[i]) {
        const action = this.annotatableActions[i];
        if (!action) continue;
        this.decisions[i] = {
          draftActionId: String(i),
          action: 'keep',
          locatorName: suggestLocatorName(action),
          valuePromotion: suggestValuePromotion(action),
          paramOrSecretKey: null,
          scopeOverride: null,
          requiresConfirmation: suggestRequiresConfirmation(action),
        };
      }
    }
    this.state = { kind: 'preview' };
  }

  skipAll(): void {
    if (this.state.kind !== 'reviewing') return;
    const startIndex = this.state.index;
    for (let i = startIndex; i < this.annotatableActions.length; i++) {
      this.decisions[i] ??= {
        draftActionId: String(i),
        action: 'skip',
        locatorName: null,
        valuePromotion: null,
        paramOrSecretKey: null,
        scopeOverride: null,
        requiresConfirmation: false,
      };
    }
    this.state = { kind: 'preview' };
  }

  goToPreview(): void {
    this.state = { kind: 'preview' };
  }

  confirm(): void {
    if (this.state.kind === 'preview') {
      this.state = { kind: 'confirm' };
    }
  }

  cancel(): void {
    this.state = { kind: 'cancelled' };
  }

  assemble(): WorkflowFile {
    const keptDecisions = this.decisions.filter((d) => d?.action === 'keep');

    const steps: WorkflowStep[] = [];
    const locators: Record<string, LocatorCandidate[]> = {};
    const params: Record<string, ParamDeclaration> = {};
    const secrets: string[] = [];
    let stepCounter = 0;

    const hasLoginUrl = this.draft.actions.some(
      (a) =>
        a.kind === 'navigate' &&
        (/login|signin/i.test(a.url_after ?? '') || /login|signin/i.test(a.url_before)),
    );

    for (const decision of keptDecisions) {
      const actionIndex = parseInt(decision.draftActionId, 10);
      const action = this.annotatableActions[actionIndex];
      if (!action) continue;

      stepCounter++;
      const stepId = `s${stepCounter}`;

      if (action.kind === 'navigate') {
        steps.push({
          id: stepId,
          verb: 'navigate',
          url: action.url_after ?? action.url_before,
          scope: decision.scopeOverride,
          requires_confirmation: decision.requiresConfirmation,
          confirmation_description: null,
          expected_cost: null,
          consequence: null,
        });
        continue;
      }

      if (action.kind === 'click') {
        const locatorName = decision.locatorName ?? `Element ${stepCounter}`;

        if (!locators[locatorName]) {
          const candidates = buildLocatorCandidates(action);
          if (candidates.length > 0) {
            locators[locatorName] = candidates;
          }
        }

        steps.push({
          id: stepId,
          verb: 'click',
          locator: locatorName,
          scope: decision.scopeOverride,
          requires_confirmation: decision.requiresConfirmation,
          confirmation_description: null,
          expected_cost: null,
          consequence: null,
        });
        continue;
      }

      if (action.kind === 'fill') {
        const locatorName = decision.locatorName ?? `Field ${stepCounter}`;

        if (!locators[locatorName]) {
          const candidates = buildLocatorCandidates(action);
          if (candidates.length > 0) {
            locators[locatorName] = candidates;
          }
        }

        let value: string | null;

        if (decision.valuePromotion === 'secret') {
          const key = decision.paramOrSecretKey ?? `secret.field${stepCounter}`;
          value = `{{ secret:${key} }}`;
          if (!secrets.includes(key)) {
            secrets.push(key);
          }
        } else if (decision.valuePromotion === 'param') {
          const key = decision.paramOrSecretKey ?? `field${stepCounter}`;
          value = `{{ param:${key} }}`;
          if (!(key in params)) {
            params[key] = {
              type: 'string',
              example: null,
              required: true,
            };
          }
        } else {
          // literal or null — value is redacted in draft
          value = null;
        }

        steps.push({
          id: stepId,
          verb: 'fill',
          locator: locatorName,
          value,
          submit: false,
          scope: decision.scopeOverride,
          requires_confirmation: decision.requiresConfirmation,
          confirmation_description: null,
          expected_cost: null,
          consequence: null,
        });
      }
    }

    const metadata = this.draft.metadata;

    const workflow: WorkflowFile = {
      version: 1,
      name: this.workflowName,
      description: null,
      security_class: this.securityClass,
      recorded_with: {
        chrome_major: metadata.chrome_major,
        yantra_version: metadata.yantra_version,
      },
      params,
      secrets,
      cookies: hasLoginUrl ? 'auto' : 'none',
      steps,
      outputs: [],
      // A recorded workflow declares no synthesis intent; the author adds the
      // block (or `do --save-as` carries it) when a Brief is wanted.
      synthesis: null,
      outputs_unredacted: false,
      _unrecorded_frames: metadata.unrecorded_frame_origins,
      _locators: locators,
    };

    return workflow;
  }
}
