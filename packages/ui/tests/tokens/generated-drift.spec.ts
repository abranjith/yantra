import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { emitThemeCss, GENERATED_THEME_PATH } from '../../src/tokens/emit.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('@no-llm Drshya generated theme drift', () => {
  it('matches a fresh emit byte for byte (CRLF normalized)', () => {
    const checkedIn = readFileSync(resolve(packageRoot, GENERATED_THEME_PATH), 'utf8').replace(
      /\r\n/gu,
      '\n',
    );

    // On failure: run `pnpm --filter @yantra/ui emit:tokens` and commit the result.
    expect(checkedIn).toBe(emitThemeCss());
  });

  it('is imported by the entry stylesheet', () => {
    const entry = readFileSync(resolve(packageRoot, 'src/styles/drshya.css'), 'utf8');

    expect(entry).toContain("@import './theme.generated.css';");
    expect(entry.indexOf("@import 'tailwindcss';")).toBeLessThan(
      entry.indexOf("@import './theme.generated.css';"),
    );
  });
});
