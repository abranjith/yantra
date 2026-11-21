import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SecretSetResponse } from '@yantra/protocol';
import { Button, Dialog, SecretField, TextField, type SecretFieldHandle } from '@yantra/ui';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { useToasts } from '../../../app/shell/toasts.js';
import { useRpc } from '../../../host/app-rpc.js';

/** Mirrors `CREDENTIAL_KEY_PATTERN` and `CREDENTIAL_MAX_BYTES` in `@yantra/protocol`. */
const CREDENTIAL_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const CREDENTIAL_MAX_BYTES = 8192;

export interface SetCredentialDialogProps {
  readonly isOpen: boolean;
  readonly initialKey?: string | undefined;
  readonly onClose: () => void;
}

/**
 * Write-only dialog for `secret.set` (FEAT-071 TASK-002):
 * - Secret value stays in an uncontrolled ref inside `SecretField` and is
 *   cleared synchronously on submit.
 * - Mutation uses `gcTime: 0`, excludes the value from `mutationKey`, and
 *   resets immediately after completion so no variable remains in cache.
 */
export function SetCredentialDialog({
  isOpen,
  initialKey,
  onClose,
}: SetCredentialDialogProps): ReactNode {
  const rpc = useRpc();
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const secretRef = useRef<SecretFieldHandle | null>(null);
  const [keyInput, setKeyInput] = useState(initialKey ?? '');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setKeyInput(initialKey ?? '');
      setKeyError(null);
      setValueError(null);
      setSubmitError(null);
    }
  }, [isOpen, initialKey]);

  const mutation = useMutation({
    mutationKey: ['credentials', 'set'],
    gcTime: 0,
    mutationFn: async (vars: { readonly key: string; readonly value: string }) =>
      rpc.request<SecretSetResponse>('secret.set', { key: vars.key, value: vars.value }),
  });

  async function submitSecret(): Promise<void> {
    const trimmedKey = keyInput.trim();
    const rawValue = secretRef.current?.readAndClear() ?? '';

    let valid = true;
    if (!CREDENTIAL_KEY_PATTERN.test(trimmedKey)) {
      setKeyError('Expected a key such as tavily.api_key (lowercase, digits, ., _, -).');
      valid = false;
    } else {
      setKeyError(null);
    }

    if (rawValue.length === 0) {
      setValueError('Secret value must not be empty.');
      valid = false;
    } else if (new TextEncoder().encode(rawValue).length > CREDENTIAL_MAX_BYTES) {
      setValueError('Secret value must not exceed 8 KiB.');
      valid = false;
    } else {
      setValueError(null);
    }

    if (!valid) return;
    setSubmitError(null);
    try {
      await mutation.mutateAsync({ key: trimmedKey, value: rawValue });
      await queryClient.invalidateQueries({ queryKey: ['credentials', 'list'] });
      toasts?.add({ title: `Stored ${trimmedKey}.`, tone: 'fulfilled' });
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to store credential.');
    } finally {
      mutation.reset();
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submitSecret();
  }

  return (
    <Dialog
      title={initialKey === undefined ? 'Set credential' : `Replace ${initialKey}`}
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {({ close }) => (
        <form onSubmit={handleFormSubmit} className="flex flex-col gap-4">
          <TextField
            label="Credential key"
            voice="engine"
            isRequired
            value={keyInput}
            onChange={(next) => {
              setKeyInput(next);
              if (keyError !== null) setKeyError(null);
            }}
            isInvalid={keyError !== null}
            errorMessage={keyError ?? undefined}
            placeholder="tavily.api_key"
          />
          <SecretField
            label="Secret value"
            isRequired
            fieldRef={secretRef}
            isInvalid={valueError !== null}
            errorMessage={valueError ?? undefined}
            onSubmit={() => {
              void submitSecret();
            }}
          />
          {submitError === null ? null : (
            <p role="alert" className="text-sm text-signal-failed-ink">
              {submitError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onPress={() => {
                secretRef.current?.readAndClear();
                close();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" isDisabled={mutation.isPending}>
              {mutation.isPending ? 'Storing…' : 'Store credential'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
