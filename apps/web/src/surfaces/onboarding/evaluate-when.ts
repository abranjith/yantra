import {
  INIT_QUESTIONS,
  evaluateWhen,
  resolveQuestionInitial,
  resolveQuestionMessage,
  type InitAnswerScalar,
  type InitQuestion,
  type InitQuestionAnswerMap,
  type InitQuestionId,
  type InitQuestionSection,
} from '@yantra/protocol/init-questions';

export { evaluateWhen, INIT_QUESTIONS, resolveQuestionInitial, resolveQuestionMessage };

export type OnboardingStepId = InitQuestionSection | 'review';

export interface OnboardingStepMeta {
  readonly id: OnboardingStepId;
  readonly title: string;
  readonly description: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStepMeta[] = [
  {
    id: 'model',
    title: 'Model',
    description: 'Choose your model provider and how Yantra authenticates.',
  },
  {
    id: 'search',
    title: 'Search',
    description: 'Optionally configure a search provider API key.',
  },
  {
    id: 'storage',
    title: 'Storage',
    description: 'Review where Yantra stores data on this machine.',
  },
  {
    id: 'context',
    title: 'Context',
    description: 'Choose whether Yantra may share your location with the agent.',
  },
  {
    id: 'review',
    title: 'Review',
    description: 'Review your choices before writing configuration.',
  },
] as const;

export const D15_RELOCATION_STEPS = [
  'Close every Yantra window',
  'Run yantra init --reset or yantra config data-dir <path>',
  'Run yantra ui',
] as const;

/** Returns the questions in `section` whose `when` condition holds for `answers`. */
export function questionsForSection(
  section: InitQuestionSection,
  answers: InitQuestionAnswerMap,
): readonly InitQuestion[] {
  return INIT_QUESTIONS.filter((q) => q.section === section && evaluateWhen(q, answers));
}

/** True when every applicable question in `section` has an explicit answer (SD-2). */
export function isStepComplete(
  section: InitQuestionSection,
  answers: InitQuestionAnswerMap,
): boolean {
  if (section === 'storage') {
    // Storage is read-only under DEVIATION-1 and submits `data_dir.configured`.
    return true;
  }

  const applicable = questionsForSection(section, answers);
  for (const question of applicable) {
    if (question.kind === 'secret') {
      // Secret questions are optional; leaving blank is explicit.
      continue;
    }
    const answer = answers[question.id];
    if (question.kind === 'select') {
      if (typeof answer !== 'string' || !question.choices?.includes(answer)) {
        return false;
      }
      continue;
    }
    if (question.kind === 'confirm') {
      if (typeof answer !== 'boolean') {
        return false;
      }
      continue;
    }
    // Text question
    if (!question.optional) {
      if (typeof answer !== 'string' || answer.trim().length === 0) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Builds the non-secret `answers` record for `onboarding.submit`.
 * Secret-kind question IDs are never included here.
 */
export function buildSubmissionAnswers(
  answers: InitQuestionAnswerMap,
  configuredDataDir: string | null,
): Record<string, InitAnswerScalar> {
  const result: Record<string, InitAnswerScalar> = {
    data_dir: configuredDataDir,
  };

  for (const question of INIT_QUESTIONS) {
    if (question.kind === 'secret' || question.id === 'data_dir') continue;
    if (!evaluateWhen(question, answers)) continue;

    const value = answers[question.id];
    if (value !== undefined) {
      result[question.id] = value;
    } else if (question.kind === 'text' && question.optional) {
      result[question.id] = '';
    }
  }

  return result;
}

/**
 * Clears answers for questions whose `when` predicate no longer holds and
 * refreshes literal `initialBy` defaults when a dependency changes.
 */
export function reconcileAnswers(
  prev: InitQuestionAnswerMap,
  changedId: InitQuestionId,
  nextValue: InitAnswerScalar,
): InitQuestionAnswerMap {
  const next: Partial<Record<InitQuestionId, InitAnswerScalar>> = {
    ...prev,
    [changedId]: nextValue,
  };

  for (const question of INIT_QUESTIONS) {
    if (question.kind === 'secret' || question.id === 'data_dir') continue;

    if (!evaluateWhen(question, next)) {
      delete next[question.id];
      continue;
    }

    if (question.initialBy?.question === changedId) {
      const literalInitial = resolveQuestionInitial(question, next);
      if (literalInitial !== null) {
        next[question.id] = literalInitial;
      }
    } else if (question.kind === 'text' && next[question.id] === undefined) {
      const literalInitial = resolveQuestionInitial(question, next);
      if (literalInitial !== null) {
        next[question.id] = literalInitial;
      }
    }
  }

  return next;
}
