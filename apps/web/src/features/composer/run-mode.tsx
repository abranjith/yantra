/**
 * Run mode (FEAT-067 TASK-012): pick a saved workflow, then fill the params
 * it declares. Values become repeated `--params key=value` in declared order
 * (the composer model); a missing required param blocks Start.
 */

import { useQuery } from '@tanstack/react-query';
import type { ListResult, WorkflowParams } from '@yantra/protocol';
import { ComboBox, TextField } from '@yantra/ui';
import { useEffect, type Key, type ReactNode } from 'react';

import { useRpc } from '../../host/app-rpc.js';

import type { ComposerValues, WorkflowParamValue } from './composer-model.js';

/** The saved workflow names, from the Ledger's `list workflows` read. */
export function useWorkflowNames(): readonly string[] {
  const rpc = useRpc();
  const result = useQuery({
    queryKey: ['workflows'],
    queryFn: () => rpc.request<{ value: ListResult }>('read.list', { args: ['workflows'] }),
    staleTime: 30_000,
  });
  return (result.data?.value.items ?? []).flatMap((item) =>
    item.kind === 'workflow' ? [item.name] : [],
  );
}

/** The declared params of `name`, once it is chosen. */
export function useWorkflowParams(name: string) {
  const rpc = useRpc();
  return useQuery({
    queryKey: ['workflow-params', name],
    enabled: name !== '',
    queryFn: () => rpc.request<WorkflowParams>('read.workflow_params', { name }),
    retry: false,
  });
}

/** `declared` with the values already typed for the same keys kept. */
export function mergeParams(
  declared: WorkflowParams['params'],
  current: readonly WorkflowParamValue[],
): WorkflowParamValue[] {
  return declared.map((param) => ({
    key: param.key,
    type: param.type,
    required: param.required,
    value: current.find((item) => item.key === param.key)?.value ?? '',
  }));
}

export interface RunModeProps {
  readonly values: ComposerValues;
  readonly setValues: (next: ComposerValues) => void;
  /** Shown once a submit was attempted. */
  readonly errors: ReadonlyMap<string, string>;
}

/** The workflow picker. */
export function WorkflowPicker({ values, setValues, errors }: RunModeProps): ReactNode {
  const names = useWorkflowNames();
  const error = errors.get('positional');
  return (
    <ComboBox
      label="Workflow"
      description="A saved workflow; its params appear below."
      isRequired
      options={names.map((name) => ({ id: name, label: name }))}
      selectedKey={values.positional === '' ? null : values.positional}
      onSelectionChange={(key: Key | null) => {
        setValues({ ...values, positional: key === null ? '' : String(key), params: [] });
      }}
      {...(error === undefined ? {} : { isInvalid: true, errorMessage: error })}
    />
  );
}

/** The chosen workflow's params as fields. */
export function WorkflowParamsFields({ values, setValues, errors }: RunModeProps): ReactNode {
  const params = useWorkflowParams(values.positional);
  const declared = params.data?.params;
  const current = values.params ?? [];
  const stale =
    declared !== undefined &&
    (current.length !== declared.length ||
      current.some((item, index) => item.key !== declared[index]?.key));
  // Adopt the declared list when it arrives for this workflow (once: then it matches).
  useEffect(() => {
    if (declared !== undefined && stale)
      setValues({ ...values, params: mergeParams(declared, current) });
  }, [declared, stale, values, current, setValues]);
  if (values.positional === '') return null;
  if (params.isError) {
    return <p className="text-signal-failed-ink">{params.error.message}</p>;
  }
  if (declared === undefined) return <p className="text-ink-2">Loading the workflow’s params…</p>;
  if (declared.length === 0) return <p className="text-ink-2">This workflow takes no params.</p>;
  return (
    <fieldset className="flex flex-col gap-3" data-part="params">
      <legend className="type-label text-ink-2">Params</legend>
      {declared.map((param) => {
        const value = current.find((item) => item.key === param.key)?.value ?? '';
        const error = errors.get(`params.${param.key}`);
        return (
          <TextField
            key={param.key}
            label={param.key}
            description={`${param.type}${param.example === null ? '' : `, e.g. ${param.example}`}`}
            isRequired={param.required}
            value={value}
            onChange={(next) => {
              setValues({
                ...values,
                params: mergeParams(declared, current).map((item) =>
                  item.key === param.key ? { ...item, value: next } : item,
                ),
              });
            }}
            {...(error === undefined ? {} : { isInvalid: true, errorMessage: error })}
          />
        );
      })}
    </fieldset>
  );
}
