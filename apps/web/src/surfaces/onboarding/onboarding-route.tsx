import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type {
  InitAnswerScalar,
  InitQuestionAnswerMap,
  InitQuestionId,
  OnboardingResult,
  OnboardingStatus,
} from '@yantra/protocol';
import { createInvocationId } from '@yantra/protocol/commands';
import { Button, ProtectedValue, type SecretFieldHandle } from '@yantra/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';
import { RpcCallError } from '../../host/rpc-client.js';

import {
  D15_RELOCATION_STEPS,
  INIT_QUESTIONS,
  ONBOARDING_STEPS,
  buildSubmissionAnswers,
  evaluateWhen,
  isStepComplete,
  reconcileAnswers,
} from './evaluate-when.js';
import { OnboardingResultView } from './onboarding-result.js';
import { QuestionStep } from './question-step.js';
import { dismissOnboarding } from './session-dismissal.js';

export interface OnboardingSurfaceProps {
  /** True when opened from Settings → Installation (`?reset=1`). */
  readonly initialReset?: boolean;
}

interface OnboardingSubmitErrorState {
  readonly reason: string;
  readonly message: string;
  readonly remediation?: string | undefined;
}

function classifyError(error: unknown): OnboardingSubmitErrorState {
  if (error instanceof RpcCallError) {
    return {
      reason: error.reason,
      message: error.message,
      remediation: error.remediation,
    };
  }
  return {
    reason: 'unknown',
    message: error instanceof Error ? error.message : 'Onboarding could not be completed.',
  };
}

/**
 * First-run and reset onboarding flow (`/onboarding`, FEAT-071 TASK-005).
 */
export function OnboardingSurface({ initialReset = false }: OnboardingSurfaceProps): ReactNode {
  const rpc = useRpc();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<InitQuestionAnswerMap>({});
  const [resetMode, setResetMode] = useState(initialReset);
  const [submitResult, setSubmitResult] = useState<OnboardingResult | null>(null);
  const [submitError, setSubmitError] = useState<OnboardingSubmitErrorState | null>(null);

  const credentialSecretRef = useRef<SecretFieldHandle | null>(null);
  const searchSecretRef = useRef<SecretFieldHandle | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    setResetMode(initialReset);
  }, [initialReset]);

  useEffect(() => {
    return () => {
      credentialSecretRef.current?.readAndClear();
      searchSecretRef.current?.readAndClear();
    };
  }, []);

  const statusQuery = useQuery({
    queryKey: ['onboarding', 'status'],
    queryFn: () => rpc.request<OnboardingStatus>('read.onboarding_status', {}),
  });

  const submitMutation = useMutation({
    mutationKey: ['onboarding', 'submit'],
    gcTime: 0,
    mutationFn: async (payload: {
      readonly answers: Record<string, InitAnswerScalar>;
      readonly secrets: {
        readonly credential_secret?: string;
        readonly search_key_secret?: string;
      };
      readonly reset: boolean;
      readonly invocation_id: string;
    }) => rpc.request<OnboardingResult>('onboarding.submit', payload),
  });

  const currentStep = ONBOARDING_STEPS[stepIndex]!;
  const stepCount = ONBOARDING_STEPS.length;

  function focusHeadingNextTick(): void {
    queueMicrotask(() => {
      headingRef.current?.focus();
    });
  }

  function handleAnswer(id: InitQuestionId, value: InitAnswerScalar): void {
    const next = reconcileAnswers(answers, id, value);
    const credQ = INIT_QUESTIONS.find((q) => q.id === 'credential_secret');
    if (credQ && !evaluateWhen(credQ, next)) {
      credentialSecretRef.current?.readAndClear();
    }
    const searchQ = INIT_QUESTIONS.find((q) => q.id === 'search_key_secret');
    if (searchQ && !evaluateWhen(searchQ, next)) {
      searchSecretRef.current?.readAndClear();
    }
    setAnswers(next);
    if (submitError !== null) setSubmitError(null);
  }

  function handleNext(): void {
    if (stepIndex < stepCount - 1) {
      setStepIndex((idx) => idx + 1);
      focusHeadingNextTick();
    }
  }

  function handleBack(): void {
    if (stepIndex > 0) {
      setStepIndex((idx) => idx - 1);
      setSubmitError(null);
      focusHeadingNextTick();
    }
  }

  function handleNotNow(): void {
    credentialSecretRef.current?.readAndClear();
    searchSecretRef.current?.readAndClear();
    dismissOnboarding();
    void navigate({ to: '/mission' });
  }

  async function handleSubmit(overrideReset?: boolean): Promise<void> {
    setSubmitError(null);
    const effectiveReset = overrideReset ?? resetMode;
    const configuredDataDir = statusQuery.data?.data_dir.configured ?? null;
    const submissionAnswers = buildSubmissionAnswers(answers, configuredDataDir);

    const credSecret = credentialSecretRef.current?.readAndClear() ?? '';
    const searchSecret = searchSecretRef.current?.readAndClear() ?? '';
    const secrets: { credential_secret?: string; search_key_secret?: string } = {};
    if (credSecret.length > 0) secrets.credential_secret = credSecret;
    if (searchSecret.length > 0) secrets.search_key_secret = searchSecret;

    try {
      const result = await submitMutation.mutateAsync({
        answers: submissionAnswers,
        secrets,
        reset: effectiveReset,
        invocation_id: createInvocationId(),
      });
      await queryClient.invalidateQueries({ queryKey: ['onboarding', 'status'] });
      setSubmitResult(result);
      focusHeadingNextTick();
    } catch (caught) {
      const err = classifyError(caught);
      setSubmitError(err);
      if (err.reason === 'keychain_unavailable') {
        setStepIndex(0);
        focusHeadingNextTick();
      }
    } finally {
      submitMutation.reset();
    }
  }

  const canAdvance = currentStep.id === 'review' || isStepComplete(currentStep.id, answers);

  if (submitResult !== null) {
    return (
      <section className="mx-auto flex max-w-3xl flex-col gap-6">
        <header>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-display font-semibold text-ink outline-none"
          >
            Setup complete
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            Yantra wrote your configuration and is ready to use.
          </p>
        </header>
        <OnboardingResultView result={submitResult} />
      </section>
    );
  }

  const providerLabel = typeof answers.provider === 'string' ? answers.provider : 'none';
  const searchProviderLabel =
    typeof answers.search_key_provider === 'string' ? answers.search_key_provider : 'skip';

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-2">
            Step {stepIndex + 1} of {stepCount}
          </p>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-display mt-1 font-semibold text-ink outline-none"
          >
            {currentStep.title}
          </h1>
          <p className="mt-1 text-sm text-ink-2">{currentStep.description}</p>
        </div>
        <Button variant="secondary" onPress={handleNotNow}>
          Not now
        </Button>
      </header>

      {resetMode ? (
        <p
          role="status"
          className="rounded-chip border border-rule bg-sunken px-3 py-2 text-xs text-ink-2"
        >
          Reset mode: existing configuration files will be backed up before writing.
        </p>
      ) : null}

      <div className="rounded-card border border-rule bg-surface p-5">
        {(['model', 'search', 'storage', 'context'] as const).map((section) => (
          <QuestionStep
            key={section}
            section={section}
            answers={answers}
            status={statusQuery.data}
            secretRefs={{
              credential_secret: credentialSecretRef,
              search_key_secret: searchSecretRef,
            }}
            onAnswer={handleAnswer}
            active={currentStep.id === section}
          />
        ))}

        {currentStep.id === 'review' ? (
          <div className="flex flex-col gap-4 text-sm">
            <dl className="grid gap-2.5 sm:grid-cols-[12rem_1fr]">
              <dt className="text-ink-2">Model provider</dt>
              <dd className="type-engine text-ink">{providerLabel}</dd>

              {answers.provider === 'anthropic' || answers.provider === 'ollama' ? (
                <>
                  <dt className="text-ink-2">Credential source</dt>
                  <dd className="type-engine text-ink">
                    {typeof answers.credential_source === 'string'
                      ? answers.credential_source
                      : 'skip'}
                  </dd>
                  {answers.credential_source === 'environment variable' ? (
                    <>
                      <dt className="text-ink-2">Environment variable</dt>
                      <dd className="type-engine text-ink">
                        {typeof answers.credential_env_name === 'string'
                          ? answers.credential_env_name
                          : ''}
                      </dd>
                    </>
                  ) : null}
                  {answers.credential_source === 'keychain' ? (
                    <>
                      <dt className="text-ink-2">Credential secret</dt>
                      <dd className="flex flex-wrap items-center gap-2 text-ink">
                        <span>Will be stored in the OS keychain as {providerLabel}.api_key</span>
                        <ProtectedValue reason="stored_secret" />
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-ink-2">Model id</dt>
                  <dd className="type-engine text-ink">
                    {typeof answers.model_id === 'string' ? answers.model_id : ''}
                  </dd>
                  {answers.provider === 'ollama' ? (
                    <>
                      <dt className="text-ink-2">Ollama base URL</dt>
                      <dd className="type-engine text-ink">
                        {typeof answers.ollama_base_url === 'string' ? answers.ollama_base_url : ''}
                      </dd>
                    </>
                  ) : null}
                </>
              ) : null}

              <dt className="text-ink-2">Search provider</dt>
              <dd className="type-engine text-ink">{searchProviderLabel}</dd>
              {searchProviderLabel === 'tavily' || searchProviderLabel === 'brave' ? (
                <>
                  <dt className="text-ink-2">Search key</dt>
                  <dd className="flex flex-wrap items-center gap-2 text-ink">
                    <span>Will be stored in the OS keychain as {searchProviderLabel}.api_key</span>
                    <ProtectedValue reason="stored_secret" />
                  </dd>
                </>
              ) : null}

              <dt className="text-ink-2">Data directory</dt>
              <dd className="type-engine text-ink">
                {statusQuery.data?.data_dir.effective ?? '~/.yantra/data'}
              </dd>

              <dt className="text-ink-2">Location sharing</dt>
              <dd className="text-ink">{answers.context_location === true ? 'Yes' : 'No'}</dd>

              {answers.context_location === true ? (
                <>
                  <dt className="text-ink-2">City or area</dt>
                  <dd className="text-ink">
                    {typeof answers.context_city === 'string' &&
                    answers.context_city.trim().length > 0
                      ? answers.context_city
                      : '(leave blank to set later)'}
                  </dd>
                </>
              ) : null}
            </dl>
          </div>
        ) : null}
      </div>

      {submitError !== null ? (
        <div
          role="alert"
          className="rounded-card border border-rule bg-surface p-4 text-sm text-signal-failed-ink"
        >
          <p className="font-medium">{submitError.message}</p>
          {submitError.remediation !== undefined &&
          submitError.reason !== 'relocation_requires_terminal' ? (
            <p className="mt-1 text-ink-2">{submitError.remediation}</p>
          ) : null}
          {submitError.reason === 'relocation_requires_terminal' ? (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-2">
              {D15_RELOCATION_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
          {submitError.reason === 'already_initialized' ? (
            <div className="mt-3">
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  setResetMode(true);
                  void handleSubmit(true);
                }}
              >
                Run setup with reset
              </Button>
            </div>
          ) : null}
          {submitError.reason === 'busy' ? (
            <div className="mt-3">
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  void handleSubmit();
                }}
              >
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Button variant="secondary" isDisabled={stepIndex === 0} onPress={handleBack}>
          Back
        </Button>
        {currentStep.id === 'review' ? (
          <Button
            variant="primary"
            isDisabled={submitMutation.isPending}
            onPress={() => {
              void handleSubmit();
            }}
          >
            {submitMutation.isPending ? 'Saving…' : 'Finish setup'}
          </Button>
        ) : (
          <Button variant="primary" isDisabled={!canAdvance} onPress={handleNext}>
            Next
          </Button>
        )}
      </div>
    </section>
  );
}
