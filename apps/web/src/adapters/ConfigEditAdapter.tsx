import { createInvocationId } from '@yantra/protocol/commands';
import { Button, Dialog, DialogTrigger, TextField } from '@yantra/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { readDocument, readFailure } from '../generated/read-document.js';
import { useRpc } from '../host/app-rpc.js';

interface ConfigListDocument {
  readonly config?: unknown;
}

/**
 * The raw config.yaml editor (`config edit`). Saving replaces config.yaml with
 * the text, so Save stays disabled until the current config has loaded: an
 * editor that opened empty would save an empty config over the real one.
 */
export function ConfigEditAdapter({
  cwd,
  defaultOpen = false,
}: {
  readonly cwd: string;
  readonly defaultOpen?: boolean;
}): ReactNode {
  const rpc = useRpc();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void readDocument(rpc, { method: 'read.config.list' }).then(
      (document) => {
        if (!active) return;
        const config = (document as ConfigListDocument | null)?.config;
        if (config === undefined) {
          setProblem('yantra config list returned no config, so there is nothing safe to edit.');
          return;
        }
        setText(JSON.stringify(config, null, 2));
        setLoaded(true);
      },
      (error: unknown) => {
        if (active) setProblem(`Couldn’t load config.yaml. ${readFailure(error)}`);
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);
  const save = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await rpc.request('command.invoke', {
        invocation: {
          invocation_id: createInvocationId(),
          path: ['config', 'edit'],
          argv: [],
          cwd,
          stdin_text: text,
        },
        displayed_effective: { settings: [], content: [] },
      });
      setSaved(true);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to save config.yaml');
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogTrigger defaultOpen={defaultOpen}>
      <Button variant="secondary">Edit config.yaml</Button>
      <Dialog title="Edit config.yaml">
        <div className="flex flex-col gap-4">
          <TextField
            multiline
            voice="engine"
            label="Raw YAML or JSON"
            value={text}
            onChange={setText}
            description="The text is supplied through the worker input collector and is never placed in argv."
          />
          {problem === null ? null : <p role="alert">{problem}</p>}
          {saved ? <p role="status">Saved and validated.</p> : null}
          <Button isDisabled={busy || !loaded || text.trim() === ''} onPress={() => void save()}>
            Save and validate
          </Button>
        </div>
      </Dialog>
    </DialogTrigger>
  );
}
