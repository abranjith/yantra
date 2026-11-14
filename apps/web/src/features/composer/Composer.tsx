/**
 * The composer (FEAT-067 TASK-010): pick a mode, say what to do, see the
 * options that command actually honors with their effective values, and
 * submit.
 *
 * - The mode switch is a tab list of CLI command words (Ask, Research, Do,
 *   Run); each mode keeps what was typed in it.
 * - The positional input (goal, topic, query) is the user's plain voice.
 * - "Options" holds the generated fields; each shows its effective value and
 *   where it came from until the user sets it.
 * - The CLI twin previews the exact command; Submit asks first when a
 *   dangerous option is in use.
 */

import { useQuery } from '@tanstack/react-query';
import type { EffectiveOptions, MissionContext } from '@yantra/protocol';
import {
  Button,
  Dialog,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
} from '@yantra/ui';
import { useMemo, useRef, useState, type ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';
import { InvocationTwin } from '../cockpit/cli-twin.js';

import {
  buildComposerModel,
  canSubmit,
  composerArgv,
  toInvocation,
  type ComposerModel,
  type ComposerPath,
  type ComposerValues,
  type OptionValue,
} from './composer-model.js';
import { FieldRenderer } from './field-renderers.js';

/** The modes the switch offers, in order; `resume` arrives only through Run again. */
export const COMPOSER_MODES: readonly { readonly path: ComposerPath; readonly label: string }[] = [
  { path: 'ask', label: 'Ask' },
  { path: 'research', label: 'Research' },
  { path: 'do', label: 'Do' },
  { path: 'run', label: 'Run' },
];

const POSITIONAL_LABEL: Readonly<Record<ComposerPath, string>> = {
  ask: 'Question',
  research: 'Topic',
  do: 'Goal',
  run: 'Workflow',
  resume: 'Run ID',
};

const EMPTY: ComposerValues = { positional: '', options: {} };

/** A stand-in operand, so effective values are not re-read on every keystroke. */
const PROBE_OPERAND = 'composer-probe';

/** What a submit hands over: the model and the effective values shown right then. */
export interface ComposerSubmission {
  readonly model: ComposerModel;
  readonly effective: EffectiveOptions | null;
  readonly cwd: string;
}

export interface ComposerProps {
  readonly initialPath?: ComposerPath;
  readonly initialValues?: Partial<Record<ComposerPath, ComposerValues>>;
  /** Submits once; resolves when the host has answered (TASK-011). */
  readonly onSubmit?: (submission: ComposerSubmission) => Promise<void>;
  /** A refusal to show inline under Submit (TASK-011). */
  readonly submitError?: string | null;
  /** Mode-specific content under the positional input (Run's workflow params, TASK-012). */
  readonly renderExtras?: (
    path: ComposerPath,
    values: ComposerValues,
    set: (next: ComposerValues) => void,
  ) => ReactNode;
  /** Why a mode cannot submit now (Do without a provider, TASK-012). */
  readonly blockedReason?: (path: ComposerPath) => ReactNode | null;
}

/** The host defaults for composing (home directory, platform). */
export function useMissionContext() {
  const rpc = useRpc();
  return useQuery({
    queryKey: ['mission-context'],
    queryFn: () => rpc.request<MissionContext>('read.mission_context'),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

function useEffectiveOptions(path: ComposerPath, argv: readonly string[], cwd: string | null) {
  const rpc = useRpc();
  return useQuery({
    queryKey: ['effective-options', path, argv, cwd],
    enabled: cwd !== null,
    queryFn: () =>
      rpc.request<EffectiveOptions>('read.effective_options', { path: [path], argv, cwd }),
    placeholderData: (previous) => previous,
  });
}

function useTemplates(): readonly string[] {
  const rpc = useRpc();
  const result = useQuery({
    queryKey: ['templates'],
    queryFn: () => rpc.request<{ value: unknown }>('read.template.list', {}),
    staleTime: 30_000,
  });
  const items = (result.data?.value as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (item as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string');
}

/** One mode's form. */
function ComposerBody({
  path,
  values,
  setValues,
  cwd,
  props,
}: {
  readonly path: ComposerPath;
  readonly values: ComposerValues;
  readonly setValues: (next: ComposerValues) => void;
  readonly cwd: string | null;
  readonly props: ComposerProps;
}): ReactNode {
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const templates = useTemplates();
  // Options resolve independently of the operand, so typing the goal reads nothing.
  const probe = useMemo(
    () =>
      composerArgv(
        buildComposerModel({
          path,
          values: { ...values, positional: PROBE_OPERAND },
          effective: null,
        }),
      ),
    [path, values],
  );
  const effective = useEffectiveOptions(path, probe, cwd);
  const model = buildComposerModel({ path, values, effective: effective.data ?? null });
  const errorFor = (field: string): string | undefined =>
    submitted || field !== 'positional'
      ? model.errors.find((error) => error.field === field)?.message
      : undefined;
  const setOption = (attribute: string, value: OptionValue | undefined): void => {
    const options = { ...values.options };
    if (value === undefined) delete options[attribute];
    else options[attribute] = value;
    setValues({ ...values, options });
  };
  const blocked = props.blockedReason?.(path) ?? null;
  const positionalError = errorFor('positional');
  const preview =
    cwd === null || model.positional.value.trim() === ''
      ? null
      : toInvocation(model, { invocationId: 'composer-preview', cwd });

  // A ref, not state: two presses in one tick must not both get through.
  const inFlight = useRef(false);
  const submit = async (): Promise<void> => {
    if (cwd === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await props.onSubmit?.({ model, effective: effective.data ?? null, cwd });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const press = (): void => {
    setSubmitted(true);
    if (!canSubmit(model) || blocked !== null || busy) return;
    if (model.dangers.length > 0) setConfirming(true);
    else void submit();
  };

  return (
    <form
      // The composer validates with the CLI's own grammars and words, not the browser's.
      noValidate
      className="flex flex-col gap-4"
      data-composer={path}
      onSubmit={(event) => {
        event.preventDefault();
        press();
      }}
    >
      <TextField
        label={POSITIONAL_LABEL[path]}
        description={model.positional.help === '' ? undefined : model.positional.help}
        multiline={path !== 'run' && path !== 'resume'}
        voice={path === 'resume' ? 'engine' : 'body'}
        isRequired={model.positional.required}
        value={values.positional}
        onChange={(next) => {
          setValues({ ...values, positional: next });
        }}
        {...(positionalError === undefined
          ? {}
          : { isInvalid: true, errorMessage: positionalError })}
      />
      {props.renderExtras?.(path, values, setValues)}
      <Disclosure>
        <DisclosureTrigger headingLevel={2}>Options ({model.fields.length})</DisclosureTrigger>
        <DisclosurePanel>
          <div className="grid gap-4 md:grid-cols-2" data-part="fields">
            {model.fields.map((field) => {
              const error = errorFor(field.flag);
              return (
                <FieldRenderer
                  key={field.flag}
                  field={field}
                  templates={templates}
                  onChange={(value) => {
                    setOption(field.optionName, value);
                  }}
                  {...(error === undefined ? {} : { error })}
                />
              );
            })}
          </div>
        </DisclosurePanel>
      </Disclosure>
      {preview === null ? null : (
        <InvocationTwin invocation={preview} label="The same command in a terminal" />
      )}
      {blocked === null ? null : <div data-part="blocked">{blocked}</div>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          isDisabled={busy || blocked !== null}
          isPending={busy}
        >
          {busy ? 'Starting…' : 'Start'}
        </Button>
        {props.submitError === undefined || props.submitError === null ? null : (
          <p role="alert" className="text-signal-failed-ink">
            {props.submitError}
          </p>
        )}
      </div>
      {confirming ? (
        <Dialog
          title="Start with these options?"
          role="alertdialog"
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
        >
          {({ close }) => (
            <>
              <ul className="flex flex-col gap-1 text-ink-2">
                {model.dangers.map((danger) => (
                  <li key={danger.flag ?? 'command'}>
                    {danger.flag === null ? (
                      ''
                    ) : (
                      <span className="type-engine">{danger.flag}: </span>
                    )}
                    {danger.reason}
                  </li>
                ))}
              </ul>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" autoFocus onPress={close}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onPress={() => {
                    close();
                    void submit();
                  }}
                >
                  Start
                </Button>
              </div>
            </>
          )}
        </Dialog>
      ) : null}
    </form>
  );
}

/** See the module comment. */
export function Composer(props: ComposerProps): ReactNode {
  const context = useMissionContext();
  const [path, setPath] = useState<ComposerPath>(props.initialPath ?? 'ask');
  const [values, setValuesFor] = useState<Partial<Record<ComposerPath, ComposerValues>>>(
    props.initialValues ?? {},
  );
  const cwd = context.data?.home ?? null;
  const modes =
    path === 'resume'
      ? [...COMPOSER_MODES, { path: 'resume' as const, label: 'Resume' }]
      : COMPOSER_MODES;
  return (
    <section aria-labelledby="composer-title" className="flex flex-col gap-4" data-part="composer">
      <h1 id="composer-title" className="text-xl font-semibold text-ink">
        Mission
      </h1>
      <Tabs
        selectedKey={path}
        onSelectionChange={(key) => {
          setPath(key as ComposerPath);
        }}
      >
        <TabList aria-label="Mode">
          {modes.map((mode) => (
            <Tab key={mode.path} id={mode.path}>
              {mode.label}
            </Tab>
          ))}
        </TabList>
        {modes.map((mode) => (
          <TabPanel key={mode.path} id={mode.path} className="pt-4">
            <ComposerBody
              path={mode.path}
              values={values[mode.path] ?? EMPTY}
              setValues={(next) => {
                setValuesFor((all) => ({ ...all, [mode.path]: next }));
              }}
              cwd={cwd}
              props={props}
            />
          </TabPanel>
        ))}
      </Tabs>
    </section>
  );
}
