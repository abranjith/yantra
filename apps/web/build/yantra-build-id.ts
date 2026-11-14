/**
 * The `yantra-build-id` Vite plugin (FEAT-065 TASK-012, D17).
 *
 * The build ID is the SHA-256 of the sorted list of emitted, content-hashed
 * file names under `assets/`. Identical sources give an identical ID; any
 * changed asset changes it. The plugin writes `dist/build-id.json`
 * (`{build_id}`) and injects `<meta name="yantra-build-id">` into
 * `index.html`, so the page and the host can compare builds.
 */

import { createHash } from 'node:crypto';

import type { Plugin } from 'vite';

/** The `<meta>` name the page reads its own build ID from. */
export const BUILD_ID_META = 'yantra-build-id';
/** The build ID during `vite dev`, where nothing is hashed. */
export const DEV_BUILD_ID = 'dev';

/** Computes the build ID from emitted file names. */
export function buildIdFrom(fileNames: Iterable<string>): string {
  const hashed = [...fileNames].filter((name) => name.startsWith('assets/')).sort();
  return createHash('sha256').update(hashed.join('\n'), 'utf8').digest('hex');
}

/** The plugin; see the module comment. */
export function yantraBuildId(): Plugin {
  return {
    name: 'yantra-build-id',
    transformIndexHtml: {
      order: 'post',
      handler: (_html, context) => {
        const content =
          context.bundle === undefined ? DEV_BUILD_ID : buildIdFrom(Object.keys(context.bundle));
        return [{ tag: 'meta', attrs: { name: BUILD_ID_META, content }, injectTo: 'head' }];
      },
    },
    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'build-id.json',
        source: `${JSON.stringify({ build_id: buildIdFrom(Object.keys(bundle)) })}\n`,
      });
    },
  };
}
