import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The standalone gallery page (spec D3, S12), served by `vite --config
 * gallery/vite.config.ts` in development and built for the e2e harness.
 *
 * It builds to `dist/gallery-site/` because `dist/gallery/` is where `tsc`
 * emits the `@yantra/ui/gallery` module.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('../dist/gallery-site', import.meta.url)),
    emptyOutDir: true,
    // Fonts and textures must be files: `default-src 'self'` blocks data: URIs.
    assetsInlineLimit: 0,
    // One local dev page bundling every primitive; size is not a concern here.
    chunkSizeWarningLimit: 2000,
  },
});
