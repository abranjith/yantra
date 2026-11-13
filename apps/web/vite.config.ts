import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { yantraBuildId } from './build/yantra-build-id.js';

/**
 * The Yantra app build (FEAT-065). Assets are content-hashed under `assets/`
 * (the host caches them immutably) and `index.html` carries the build ID.
 */
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss(), yantraBuildId()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // `default-src 'self'` blocks data: URIs, so fonts and images must be files.
    assetsInlineLimit: 0,
    assetsDir: 'assets',
    sourcemap: false,
    // No modulepreload polyfill: it is an inline script, which the CSP blocks.
    modulePreload: { polyfill: false },
  },
});
