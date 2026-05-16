/**
 * esbuild configuration for the recorder overlay IIFE bundle.
 *
 * Builds src/workflow/recorder/overlay/index.ts → dist/recorder-overlay.iife.js
 * as a self-contained browser IIFE with zero Node.js APIs.
 *
 * Run via: pnpm --filter @yantra/core build:recorder-overlay
 *
 * The bundle includes:
 *   - The overlay UI (recording indicator, action counter, toast)
 *   - The ElementDescriptor builder
 *   - The event listeners
 *   - The locator ranking algorithm (from FEAT-004) for in-page candidate generation
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..', '..', '..', '..');

const isDev = process.env.NODE_ENV !== 'production';

await build({
  entryPoints: [resolve(__dirname, 'index.ts')],
  outfile: resolve(pkgRoot, 'dist', 'recorder-overlay.iife.js'),
  format: 'iife',
  bundle: true,
  // Dev: readable; CI/prod: minified
  minify: !isDev,
  sourcemap: isDev,
  target: 'chrome120',
  platform: 'browser',
  treeShaking: true,
  // Prevent Node-isms from leaking into the bundle
  define: {
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
  },
  // Banner with generation timestamp for debugging
  banner: {
    js: `/* yantra recorder overlay — built ${new Date().toISOString()} */`,
  },
});

console.log('recorder-overlay.iife.js built successfully');
