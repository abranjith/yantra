import { useNavigate } from '@tanstack/react-router';
import { Button, Checkbox, Dialog, DialogTrigger } from '@yantra/ui';
import { useState, type ReactNode } from 'react';

/**
 * "Run setup again" button + confirmation Dialog for Settings → Installation
 * (FEAT-071 TASK-005). Explains that existing files are backed up and requires
 * explicit confirmation before navigating to `/onboarding?reset=1`.
 */
export function InstallationResetTrigger(): ReactNode {
  const navigate = useNavigate();
  const [confirmed, setConfirmed] = useState(false);

  return (
    <DialogTrigger
      onOpenChange={(open) => {
        if (!open) setConfirmed(false);
      }}
    >
      <Button variant="secondary">Run setup again</Button>
      <Dialog role="alertdialog" title="Run setup again">
        {({ close }) => (
          <div className="flex flex-col gap-4 text-sm">
            <p className="text-ink-2">
              Existing <code className="type-engine">config.yaml</code> and{' '}
              <code className="type-engine">profile.yaml</code> files will be backed up before new
              configuration is written (equivalent to{' '}
              <code className="type-engine">yantra init --reset</code>).
            </p>
            <Checkbox isSelected={confirmed} onChange={setConfirmed}>
              I understand existing configuration files will be backed up and replaced.
            </Checkbox>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onPress={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                isDisabled={!confirmed}
                onPress={() => {
                  close();
                  void navigate({ to: '/onboarding', search: { reset: true } });
                }}
              >
                Continue to setup
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </DialogTrigger>
  );
}
