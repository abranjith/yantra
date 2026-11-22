import type {
  InitAnswerScalar,
  InitQuestion,
  InitQuestionAnswerMap,
  InitQuestionId,
  InitQuestionSection,
  OnboardingStatus,
} from '@yantra/protocol';
import { Radio, RadioGroup, SecretField, TextField, type SecretFieldHandle } from '@yantra/ui';
import type { ReactNode, RefObject } from 'react';

import {
  D15_RELOCATION_STEPS,
  questionsForSection,
  resolveQuestionInitial,
  resolveQuestionMessage,
} from './evaluate-when.js';

export interface OnboardingSecretRefs {
  readonly credential_secret: RefObject<SecretFieldHandle | null>;
  readonly search_key_secret: RefObject<SecretFieldHandle | null>;
}

export interface QuestionStepProps {
  readonly section: InitQuestionSection;
  readonly answers: InitQuestionAnswerMap;
  readonly status: OnboardingStatus | undefined;
  readonly secretRefs: OnboardingSecretRefs;
  readonly onAnswer: (id: InitQuestionId, value: InitAnswerScalar) => void;
  /** True when this step is currently visible; inactive steps stay hidden so secret refs persist until submit. */
  readonly active: boolean;
}

function isEngineTextQuestion(id: InitQuestionId): boolean {
  return id === 'credential_env_name' || id === 'model_id' || id === 'ollama_base_url';
}

function renderQuestion(
  question: InitQuestion,
  answers: InitQuestionAnswerMap,
  keychainAvailable: boolean,
  secretRefs: OnboardingSecretRefs,
  onAnswer: (id: InitQuestionId, value: InitAnswerScalar) => void,
): ReactNode {
  const label = resolveQuestionMessage(question, answers);
  const current = answers[question.id];

  if (question.kind === 'select') {
    const selectedValue = typeof current === 'string' ? current : null;
    return (
      <RadioGroup
        key={question.id}
        label={label}
        isRequired={!question.optional}
        value={selectedValue}
        onChange={(next) => {
          onAnswer(question.id, next);
        }}
      >
        {(question.choices ?? []).map((choice) => {
          const isDisabledKeychain =
            question.id === 'credential_source' && choice === 'keychain' && !keychainAvailable;
          return (
            <Radio
              key={choice}
              value={choice}
              isDisabled={isDisabledKeychain}
              {...(isDisabledKeychain
                ? {
                    description:
                      'OS keychain is unavailable in this environment. Choose environment variable or skip, or unlock your OS keychain first.',
                  }
                : {})}
            >
              {choice}
            </Radio>
          );
        })}
      </RadioGroup>
    );
  }

  if (question.kind === 'confirm') {
    const selectedValue = current === true ? 'yes' : current === false ? 'no' : null;
    return (
      <RadioGroup
        key={question.id}
        label={label}
        value={selectedValue}
        onChange={(next) => {
          onAnswer(question.id, next === 'yes');
        }}
      >
        <Radio value="yes">Yes</Radio>
        <Radio value="no">No</Radio>
      </RadioGroup>
    );
  }

  if (question.kind === 'secret') {
    const ref =
      question.id === 'credential_secret'
        ? secretRefs.credential_secret
        : secretRefs.search_key_secret;
    return (
      <SecretField
        key={question.id}
        name={question.id}
        label={label}
        fieldRef={ref}
        description="Optional. Leave blank to skip storing a secret now. Stored values can't be viewed."
      />
    );
  }

  // kind === 'text'
  const initialValue = resolveQuestionInitial(question, answers) ?? '';
  const textValue = typeof current === 'string' ? current : initialValue;
  return (
    <TextField
      key={question.id}
      label={label}
      isRequired={!question.optional}
      voice={isEngineTextQuestion(question.id) ? 'engine' : 'body'}
      value={textValue}
      onChange={(next) => {
        onAnswer(question.id, next);
      }}
    />
  );
}

/**
 * Renders the questions for one onboarding section. Inactive sections stay
 * mounted with `hidden` so uncontrolled `SecretField` refs remain available
 * until final submission on Review without ever storing secrets in state.
 */
export function QuestionStep({
  section,
  answers,
  status,
  secretRefs,
  onAnswer,
  active,
}: QuestionStepProps): ReactNode {
  if (section === 'storage') {
    return (
      <div hidden={!active} className={active ? 'flex flex-col gap-4' : 'hidden'}>
        <div className="rounded-frame border border-rule bg-surface p-4 text-caption">
          <p className="font-medium text-ink">Current data directory</p>
          <p className="type-engine mt-1 text-ink">
            {status?.data_dir.effective ?? '~/.yantra/data'}
          </p>
          <p className="mt-1 text-micro text-ink-2">
            Source: {status?.data_dir.source ?? 'default'}
            {status?.data_dir.configured !== null && status?.data_dir.configured !== undefined
              ? ` (configured: ${status.data_dir.configured})`
              : ''}
          </p>
        </div>
        <div className="rounded-frame border border-rule bg-sunken p-4 text-caption text-ink-2">
          <p className="font-medium text-ink">
            Storage location cannot be changed while the app is running.
          </p>
          <p className="mt-1">To use a different data directory:</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            {D15_RELOCATION_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </div>
    );
  }

  const questions = questionsForSection(section, answers);
  const keychainAvailable = status?.keychain_available ?? true;

  return (
    <div hidden={!active} className={active ? 'flex flex-col gap-5' : 'hidden'}>
      {questions.map((q) => renderQuestion(q, answers, keychainAvailable, secretRefs, onAnswer))}
    </div>
  );
}
