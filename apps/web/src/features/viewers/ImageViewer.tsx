/**
 * The image viewer (FEAT-066): one capture through its signed URL, fitted to
 * the page or at its natural size.
 */

import { Switch } from '@yantra/ui';
import { useState, type ReactNode } from 'react';

import { useArtifactUrl } from '../../data/runs.js';

/** See the module comment. */
export function ImageViewer({
  runId,
  path,
}: {
  readonly runId: string;
  readonly path: string;
}): ReactNode {
  const url = useArtifactUrl(runId, path);
  const [natural, setNatural] = useState(false);
  if (url.isError) return <p className="text-signal-failed-ink">This image could not be opened.</p>;
  if (url.data === undefined)
    return (
      <p role="status" className="text-ink-2">
        Loading image…
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      <Switch isSelected={natural} onChange={setNatural}>
        Natural size
      </Switch>
      <div className={natural ? 'overflow-auto' : ''}>
        <img
          src={url.data.url}
          alt={`Capture ${path}`}
          data-fit={natural ? 'natural' : 'fit'}
          className={natural ? 'max-w-none' : 'max-h-[40rem] max-w-full object-contain'}
        />
      </div>
    </div>
  );
}
