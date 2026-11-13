/**
 * Artifact access for the run pages (FEAT-066): images through signed URLs,
 * downloads of `download`-only files, and links into the bounded viewers.
 */

import { Link as RouterLink } from '@tanstack/react-router';
import { Button } from '@yantra/ui';
import { useState, type ReactNode } from 'react';

import { useArtifactUrl } from '../../data/runs.js';
import { useRpc } from '../../host/app-rpc.js';
import { browserNav } from '../../host/browser-nav.js';

/** An image loaded through its signed URL; nothing loads until the URL is signed. */
export function ArtifactImage({
  runId,
  path,
  alt,
}: {
  readonly runId: string;
  readonly path: string;
  readonly alt: string;
}): ReactNode {
  const url = useArtifactUrl(runId, path);
  if (url.isError) return <span className="text-ink-2">Image unavailable.</span>;
  if (url.data === undefined) return <span className="text-ink-2">Loading image…</span>;
  return (
    <img
      src={url.data.url}
      alt={alt}
      loading="lazy"
      className="max-h-48 w-full rounded-chip object-contain"
    />
  );
}

/** A button that downloads one `download`-exposure file through a fresh signed URL. */
export function DownloadArtifact({
  runId,
  path,
  children,
}: {
  readonly runId: string;
  readonly path: string;
  readonly children: ReactNode;
}): ReactNode {
  const rpc = useRpc();
  const [failed, setFailed] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        onPress={() => {
          setFailed(false);
          rpc
            .request<{ url: string }>('artifact.url', { run_id: runId, path })
            .then(({ url }) => {
              // Served as an attachment: the browser saves it and stays on this page.
              browserNav.assign(url);
            })
            .catch(() => {
              setFailed(true);
            });
        }}
      >
        {children}
      </Button>
      {failed ? <span className="text-signal-failed-ink">Couldn’t download {path}.</span> : null}
    </span>
  );
}

/** A link to the bounded viewer of one artifact. */
export function ViewerLink({
  runId,
  path,
  children,
}: {
  readonly runId: string;
  readonly path: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <RouterLink
      to="/runs/$runId/artifacts/$"
      params={{ runId, _splat: path }}
      className="text-accent-ink underline underline-offset-2"
    >
      {children}
    </RouterLink>
  );
}
