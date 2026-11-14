/**
 * The bounded artifact viewer (`/runs/<id>/artifacts/<path>`, FEAT-066
 * TASK-008). It dispatches by the file's registry viewer:
 *
 * - `jsonl`: windowed and virtualized, any length;
 * - `json`, `markdown`, `text`: loaded whole only when the file is within its
 *   inline cap; over it, "Show in folder" instead;
 * - `image`: through a signed URL, fitted or natural size;
 * - `typed` files (the Brief, the document) live on the Result tab, and
 *   `download` files (HTML) are only ever downloaded.
 *
 * Only files the run's public inventory lists can be opened here.
 */

import { createRoute, Link as RouterLink } from '@tanstack/react-router';
import type { ArtifactInventoryItem } from '@yantra/protocol';
import { SafeMarkdown } from '@yantra/ui';
import type { ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { useArtifactText, useRunResult } from '../data/runs.js';
import { formatBytes } from '../features/format.js';
import { DownloadArtifact } from '../features/run-result/artifact-links.js';
import { ImageViewer } from '../features/viewers/ImageViewer.js';
import { JsonlViewer } from '../features/viewers/JsonlViewer.js';
import { JsonViewer } from '../features/viewers/JsonViewer.js';
import { ShowInFolder } from '../features/viewers/ShowInFolder.js';
import { TextViewer } from '../features/viewers/TextViewer.js';

function parseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** A whole-file viewer for a file within its cap. */
function WholeFile({
  runId,
  item,
}: {
  readonly runId: string;
  readonly item: ArtifactInventoryItem;
}): ReactNode {
  const text = useArtifactText(runId, item.path, !item.over_inline_cap);
  if (item.over_inline_cap) {
    return (
      <div
        data-part="too-large"
        className="flex flex-col gap-2 rounded-control border border-rule bg-sunken p-4"
      >
        <p className="text-ink">
          {item.path} is too large to open here ({formatBytes(item.bytes)}).
        </p>
        <ShowInFolder runId={runId} />
      </div>
    );
  }
  if (text.isError) return <p className="text-signal-failed-ink">{text.error.message}</p>;
  if (text.data === undefined)
    return (
      <p role="status" className="text-ink-2">
        Loading {item.path}…
      </p>
    );
  if (item.viewer === 'markdown') return <SafeMarkdown>{text.data}</SafeMarkdown>;
  if (item.viewer === 'json') {
    const parsed = parseJson(text.data);
    return parsed.ok ? (
      <JsonViewer value={parsed.value} label={item.path} />
    ) : (
      <div className="flex flex-col gap-2">
        <p className="text-signal-partial-ink">
          {item.path} is not valid JSON; showing it as text.
        </p>
        <TextViewer text={text.data} label={item.path} />
      </div>
    );
  }
  return <TextViewer text={text.data} label={item.path} />;
}

/** The viewer for one inventory item. */
export function ArtifactBody({
  runId,
  item,
}: {
  readonly runId: string;
  readonly item: ArtifactInventoryItem;
}): ReactNode {
  if (item.exposure === 'typed') {
    return (
      <p className="text-ink">
        {item.path} is shown on the run’s{' '}
        <RouterLink
          to="/runs/$runId"
          params={{ runId }}
          className="text-accent-ink underline underline-offset-2"
        >
          Result tab
        </RouterLink>
        .
      </p>
    );
  }
  if (item.exposure === 'download' || item.viewer === 'none') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-ink-2">
          {item.path} is not opened in the app; it can only be downloaded.
        </p>
        <DownloadArtifact runId={runId} path={item.path}>
          Download {item.path}
        </DownloadArtifact>
      </div>
    );
  }
  if (item.viewer === 'jsonl') return <JsonlViewer runId={runId} path={item.path} />;
  if (item.viewer === 'image') {
    return item.over_inline_cap ? (
      <div
        data-part="too-large"
        className="flex flex-col gap-2 rounded-control border border-rule bg-sunken p-4"
      >
        <p className="text-ink">
          {item.path} is too large to show here ({formatBytes(item.bytes)}).
        </p>
        <ShowInFolder runId={runId} />
      </div>
    ) : (
      <ImageViewer runId={runId} path={item.path} />
    );
  }
  return <WholeFile runId={runId} item={item} />;
}

/** One artifact in its viewer. */
export function ArtifactPage({
  runId,
  path,
}: {
  readonly runId: string;
  readonly path: string;
}): ReactNode {
  const result = useRunResult(runId);
  const item = result.data?.artifacts.find((artifact) => artifact.path === path);
  return (
    <div className="flex flex-col gap-4">
      <RouterLink
        to="/runs/$runId"
        params={{ runId }}
        className="text-accent-ink underline underline-offset-2"
      >
        Back to the run
      </RouterLink>
      <h1 className="type-engine text-xl text-ink">{path}</h1>
      {result.isError ? (
        <p className="text-signal-failed-ink">{result.error.message}</p>
      ) : result.data === undefined ? (
        <p role="status" className="text-ink-2">
          Loading…
        </p>
      ) : item === undefined ? (
        <p className="text-ink">This file is not one the app can show for this run.</p>
      ) : (
        <ArtifactBody runId={runId} item={item} />
      )}
    </div>
  );
}

function ArtifactRoutePage(): ReactNode {
  const { runId, _splat } = artifactRoute.useParams();
  return <ArtifactPage runId={runId} path={_splat ?? ''} />;
}

/** `/runs/$runId/artifacts/$`. */
export const artifactRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId/artifacts/$',
  component: ArtifactRoutePage,
});
