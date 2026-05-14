/**
 * esbuild configuration and invocation for the InjectedScript bundle.
 *
 * Builds src/locator/injected/index.ts → dist/injected.bundle.js as a
 * self-contained browser IIFE that registers window.__yantra. The bundle
 * runs in the Chrome page context and must have zero Node.js APIs.
 *
 * Run via: pnpm --filter @yantra/core build:injected
 * CI gate: bundle size must be < 50 KB (enforced by build.spec.ts).
 */

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..', '..');

await build({
  entryPoints: [resolve(__dirname, 'injected', 'index.ts')],
  outfile: resolve(pkgRoot, 'dist', 'injected.bundle.js'),
  format: 'iife',
  bundle: true,
  minify: true,
  sourcemap: true,
  target: 'chrome120',
  platform: 'browser',
  // tree-shake aggressively
  treeShaking: true,
  // no Node-isms in output
  define: { 'process.env.NODE_ENV': '"production"' },
});
