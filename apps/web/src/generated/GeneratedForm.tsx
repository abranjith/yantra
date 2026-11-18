import type { InvocationSummary, LeafEntry } from '@yantra/protocol';
import { Button, Dialog, Select, Switch, TextField } from '@yantra/ui';
import { useMemo, useState, type Key, type ReactNode } from 'react';

import { InvocationTwin } from '../features/cockpit/cli-twin.js';
import { useRpc } from '../host/app-rpc.js';

import {
  buildInvocation,
  deriveFields,
  initialFormValues,
  UnsupportedFieldError,
  validateDraft,
  type FormValues,
} from './form-model.js';
import { invokeCommand } from './use-invocation.js';

export interface GeneratedFormProps {
  readonly command: LeafEntry;
  readonly cwd: string;
  readonly initialValues?: FormValues;
  readonly onSubmitted?: (summary: InvocationSummary) => void;
}

export function GeneratedForm({
  command,
  cwd,
  initialValues = {},
  onSubmitted,
}: GeneratedFormProps): ReactNode {
  const rpc = useRpc();
  const fieldResult = useMemo(() => {
    try {
      return { fields: deriveFields(command), error: null } as const;
    } catch (error) {
      return { fields: [], error } as const;
    }
  }, [command]);
  const fields = fieldResult.fields;
  const [values, setValues] = useState<FormValues>(() => ({
    ...initialFormValues(fields),
    ...initialValues,
  }));
  const [confirming, setConfirming] = useState(false);
  const [consenting, setConsenting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const consent =
    command.path.join(' ') === 'browser install' || command.path.join(' ') === 'browser update';
  const visible = fields.filter((field) => !(consent && field.flag === '--yes'));
  const invocation = useMemo(() => buildInvocation(command, values, cwd), [command, values, cwd]);

  const set = (id: string, value: string | boolean | undefined): void =>
    setValues((current) => ({ ...current, [id]: value }));
  const perform = async (withConsent = false): Promise<void> => {
    const issues = validateDraft(fields, values);
    if (issues.length > 0) {
      setProblem(issues[0]!.message);
      return;
    }
    const nextValues = withConsent ? { ...values, yes: true } : values;
    const next = buildInvocation(command, nextValues, cwd);
    setBusy(true);
    setProblem(null);
    try {
      const summary = await invokeCommand(rpc, next);
      onSubmitted?.(summary);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const submit = (): void => {
    if (command.danger.level === 'confirm') {
      setConfirming(true);
      return;
    }
    if (consent) {
      setConsenting(true);
      return;
    }
    void perform();
  };

  if (fieldResult.error instanceof UnsupportedFieldError)
    return <p role="alert">Unsupported field: {fieldResult.error.field}</p>;
  if (fieldResult.error !== null)
    throw fieldResult.error instanceof Error
      ? fieldResult.error
      : new Error('Unable to derive generated fields');

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {visible.map((field) => {
        const value = values[field.id];
        if (!field.takesValue)
          return (
            <Switch
              key={field.id}
              isSelected={value === true}
              onChange={(selected) => set(field.id, selected || undefined)}
            >
              {field.flag ?? field.id}
            </Switch>
          );
        if (field.inputKind.kind === 'enum')
          return (
            <Select
              key={field.id}
              label={field.flag ?? field.id}
              description={field.description}
              options={field.inputKind.choices.map((choice) => ({ id: choice, label: choice }))}
              selectedKey={typeof value === 'string' ? value : null}
              onSelectionChange={(key: Key | null) =>
                set(field.id, key === null ? undefined : String(key))
              }
            />
          );
        return (
          <TextField
            key={field.id}
            label={field.flag ?? field.id}
            description={field.description}
            voice={field.inputKind.kind === 'path' ? 'engine' : 'body'}
            value={typeof value === 'string' ? value : ''}
            onChange={(next) => set(field.id, next || undefined)}
          />
        );
      })}
      <InvocationTwin invocation={invocation} label="CLI twin" />
      {problem === null ? null : (
        <p role="alert" className="text-signal-failed-ink">
          {problem}
        </p>
      )}
      <div aria-live="polite" className="text-ink-2">
        {busy ? 'Submitting…' : ''}
      </div>
      <Button type="submit" isDisabled={busy}>
        {busy ? 'Submitting…' : 'Run'}
      </Button>
      {confirming ? (
        <Dialog
          title="Confirm command"
          role="alertdialog"
          isOpen
          onOpenChange={(open) => setConfirming(open)}
        >
          {({ close }) => (
            <>
              <p>
                This has a {command.effect} effect:{' '}
                {command.danger.level === 'confirm' ? command.danger.reason : ''}
              </p>
              <InvocationTwin invocation={invocation} />
              <div className="flex gap-3">
                <Button
                  autoFocus
                  variant="secondary"
                  onPress={() => {
                    close();
                    setConfirming(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onPress={() => {
                    close();
                    setConfirming(false);
                    void perform();
                  }}
                >
                  Confirm
                </Button>
              </div>
            </>
          )}
        </Dialog>
      ) : null}
      {consenting ? (
        <Dialog
          title="Confirm browser change"
          role="alertdialog"
          isOpen
          onOpenChange={(open) => setConsenting(open)}
        >
          {({ close }) => (
            <>
              <p>
                Yantra will download or replace a managed browser. Run starts wait while this
                exclusive operation finishes.
              </p>
              <div className="flex gap-3">
                <Button
                  autoFocus
                  variant="secondary"
                  onPress={() => {
                    close();
                    setConsenting(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onPress={() => {
                    close();
                    setConsenting(false);
                    void perform(true);
                  }}
                >
                  Accept and continue
                </Button>
              </div>
            </>
          )}
        </Dialog>
      ) : null}
    </form>
  );
}
