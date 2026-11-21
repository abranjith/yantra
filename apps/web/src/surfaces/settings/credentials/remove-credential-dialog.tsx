import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CredentialRow, SecretRemoveResponse } from '@yantra/protocol';
import { Button, Checkbox, Dialog } from '@yantra/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useToasts } from '../../../app/shell/toasts.js';
import { useRpc } from '../../../host/app-rpc.js';

export interface RemoveCredentialDialogProps {
  readonly row: CredentialRow | null;
  readonly onClose: () => void;
}

/**
 * Guarded removal dialog for `secret.rm` (FEAT-071 TASK-002, SD-6):
 * - When `row.referenced_by` is non-empty, lists every referencing config entry
 *   and requires an explicit confirmation checkbox before enabling Remove.
 */
export function RemoveCredentialDialog({ row, onClose }: RemoveCredentialDialogProps): ReactNode {
  const rpc = useRpc();
  const queryClient = useQueryClient();
  const toasts = useToasts();
  const [confirmed, setConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    setConfirmed(false);
    setSubmitError(null);
  }, [row]);

  const mutation = useMutation({
    mutationKey: ['credentials', 'rm'],
    gcTime: 0,
    mutationFn: async (key: string) => rpc.request<SecretRemoveResponse>('secret.rm', { key }),
  });

  if (row === null) return null;

  const hasReferences = row.referenced_by.length > 0;
  const canRemove = (!hasReferences || confirmed) && !mutation.isPending;

  async function handleRemove(): Promise<void> {
    if (row === null || !canRemove) return;
    setSubmitError(null);
    try {
      const result = await mutation.mutateAsync(row.key);
      await queryClient.invalidateQueries({ queryKey: ['credentials', 'list'] });
      toasts?.add({
        title:
          result.status === 'removed'
            ? `Removed ${row.key}.`
            : `${row.key} was not in the keychain.`,
        tone: 'fulfilled',
      });
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to remove credential.');
    } finally {
      mutation.reset();
    }
  }

  return (
    <Dialog
      title={`Remove ${row.key}`}
      role="alertdialog"
      isOpen={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {({ close }) => (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink">
            Remove <span className="type-engine">{row.key}</span> from the OS keychain?
          </p>
          {hasReferences ? (
            <div className="flex flex-col gap-3 rounded-card border border-rule bg-sunken p-3">
              <p className="text-sm font-medium text-ink">
                This credential is referenced by {row.referenced_by.length}{' '}
                {row.referenced_by.length === 1 ? 'configuration entry' : 'configuration entries'}:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
                {row.referenced_by.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    <span>
                      {item.kind} {item.id}
                    </span>{' '}
                    <span className="type-engine">
                      {item.ref.kind === 'secret'
                        ? `\${secret:${item.ref.key}}`
                        : `\${env:${item.ref.name}}`}
                    </span>
                  </li>
                ))}
              </ul>
              <Checkbox isSelected={confirmed} onChange={setConfirmed}>
                I confirm removing {row.key} even though it is referenced above.
              </Checkbox>
            </div>
          ) : null}
          {submitError === null ? null : (
            <p role="alert" className="text-sm text-signal-failed-ink">
              {submitError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onPress={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isDisabled={!canRemove}
              onPress={() => {
                void handleRemove();
              }}
            >
              {mutation.isPending ? 'Removing…' : 'Remove credential'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
