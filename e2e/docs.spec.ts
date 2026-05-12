import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('@no-llm docs presence', () => {
  it('contains required root docs files', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    const contributing = readFileSync(resolve(repoRoot, 'CONTRIBUTING.md'), 'utf8');
    const license = readFileSync(resolve(repoRoot, 'LICENSE'), 'utf8');

    expect(readme.length).toBeGreaterThan(0);
    expect(contributing.length).toBeGreaterThan(0);
    expect(license.length).toBeGreaterThan(0);
  });

  it('mentions all core workspace packages in README', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');

    expect(readme).toContain('@yantra/protocol');
    expect(readme).toContain('@yantra/core');
    expect(readme).toContain('@yantra/agent');
    expect(readme).toContain('@yantra/test-helpers');
    expect(readme).toContain('@yantra/cli');
  });
});
