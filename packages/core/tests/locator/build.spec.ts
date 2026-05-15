import { access, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeAll } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..', '..');
const bundlePath = resolve(pkgRoot, 'dist', 'injected.bundle.js');

const BUNDLE_SIZE_LIMIT_KB = 50;

describe('@no-llm InjectedScript bundle', () => {
  beforeAll(async () => {
    // Build the bundle before running assertions
    const { build } = await import('esbuild');
    const { resolve: pathResolve, dirname: pathDirname } = await import('node:path');
    const { fileURLToPath: ftu } = await import('node:url');
    const { mkdir } = await import('node:fs/promises');

    const srcDir = pathDirname(ftu(import.meta.url));
    const pkg = pathResolve(srcDir, '..', '..');
    const outFile = pathResolve(pkg, 'dist', 'injected.bundle.js');
    const srcEntry = pathResolve(pkg, 'src', 'locator', 'injected', 'index.ts');

    // Ensure dist/ exists
    await mkdir(pathResolve(pkg, 'dist'), { recursive: true });

    await build({
      entryPoints: [srcEntry],
      outfile: outFile,
      format: 'iife',
      bundle: true,
      minify: true,
      sourcemap: true,
      target: 'chrome120',
      platform: 'browser',
      treeShaking: true,
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  }, 30_000); // 30s timeout for build

  it('produces dist/injected.bundle.js', async () => {
    await expect(access(bundlePath)).resolves.not.toThrow();
  });

  it('bundle size is under 50 KB', async () => {
    const { size } = await stat(bundlePath);
    const sizeKb = size / 1024;
    expect(sizeKb).toBeLessThan(BUNDLE_SIZE_LIMIT_KB);
  });

  it('bundle contains no require() calls (pure browser IIFE)', async () => {
    const content = await readFile(bundlePath, 'utf8');
    expect(content).not.toContain('require(');
  });

  it('bundle contains no process.env references', async () => {
    const content = await readFile(bundlePath, 'utf8');
    // process.env.NODE_ENV is replaced by define, others should not exist
    expect(content).not.toMatch(/process\.env\.[A-Z_]+/);
  });

  it('bundle assigns to window.__yantra', async () => {
    const content = await readFile(bundlePath, 'utf8');
    // The minifier may use window["__yantra"] or window.__yantra
    const hasAssignment =
      content.includes('window.__yantra') || content.includes('window["__yantra"]');
    expect(hasAssignment).toBe(true);
  });
});
