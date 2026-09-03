import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const lintMessagesFor = async (filePath: string) => {
  const eslint = new ESLint({
    cwd: repoRoot,
    ignore: false,
  });

  const results = await eslint.lintFiles([filePath]);
  return results.flatMap((result) => result.messages);
};

describe('@no-llm lint boundary rules', () => {
  it('contains no literal NUL bytes in production TypeScript source', () => {
    const sourceFiles = globSync('{apps,packages}/*/src/**/*.ts', { cwd: repoRoot });
    const withNul = sourceFiles.filter((filePath) =>
      readFileSync(resolve(repoRoot, filePath)).includes(0),
    );

    expect(withNul).toEqual([]);
  });

  it('rejects @yantra/agent imports from packages/core', async () => {
    const fixturePath = resolve(repoRoot, 'packages/core/src/_lint-fixtures/core-imports-agent.ts');

    const messages = await lintMessagesFor(fixturePath);
    const restricted = messages.filter((message) => message.ruleId === 'no-restricted-imports');

    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toContain('must not import from @yantra/agent');
  }, 30_000);

  it('rejects Pi SDK imports in packages/agent outside src/adapters/pi', async () => {
    const fixturePath = resolve(
      repoRoot,
      'packages/agent/src/_lint-fixtures/agent-pi-import-outside-adapter.ts',
    );

    const messages = await lintMessagesFor(fixturePath);
    const restricted = messages.filter((message) => message.ruleId === 'no-restricted-imports');

    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toContain(
      'may only be imported under packages/agent/src/adapters/pi/',
    );
  }, 30_000);

  it('rejects pi-agent-core imports outside packages/agent', async () => {
    const fixturePath = resolve(
      repoRoot,
      'packages/core/src/_lint-fixtures/core-imports-pi-agent-core.ts',
    );

    const messages = await lintMessagesFor(fixturePath);
    const restricted = messages.filter((message) => message.ruleId === 'no-restricted-imports');

    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toContain(
      'Direct pi-agent-core imports are forbidden outside packages/agent',
    );
  }, 30_000);

  it('rejects website-specific logic in package source', async () => {
    // The standing rule: automation works from generic structural signals, and
    // a site name in a value the code evaluates is a bug. Enforced rather than
    // trusted, because the habit is easy to fall back into under pressure.
    const fixturePath = resolve(
      repoRoot,
      'packages/core/src/_lint-fixtures/site-specific-logic.ts',
    );

    const messages = await lintMessagesFor(fixturePath);
    const restricted = messages.filter((message) => message.ruleId === 'no-restricted-syntax');

    // One string literal comparison and one template chunk.
    expect(restricted).toHaveLength(2);
    expect(restricted[0]?.message).toContain('Website-specific logic is forbidden');
  }, 30_000);

  it('keeps the query-plan module free of widget-layer imports', () => {
    // The WHAT rung is pure string and ranking logic, and staying that way is
    // what lets it be tested with no port at all — and what stops the single
    // ranking rule from acquiring a second implementation inside a driver.
    const source = readFileSync(
      resolve(repoRoot, 'packages/core/src/interaction/query-plan.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map(
      (match) => match[1] ?? '',
    );

    expect(imports.filter((specifier) => specifier.includes('widgets/'))).toEqual([]);
    expect(imports.every((specifier) => specifier.startsWith('./'))).toBe(true);
  });

  it('keeps candidate ranking to exactly one implementation', () => {
    // Two ideas of "which offer answers this request" is the defect the WHAT
    // rung exists to remove, so the widget-layer entry point delegates rather
    // than restating the tier ladder.
    const source = readFileSync(
      resolve(repoRoot, 'packages/core/src/widgets/option/candidates.ts'),
      'utf8',
    );

    expect(source).toContain('return rankAgainstRequested(candidates, requested);');
    expect(source).not.toContain('MATCH_TIERS');
  });

  it('mints interactable handles from exactly one composed traversal', () => {
    // The arrangement this replaced paired a record list from one traversal
    // with a handle list from an independent `page.$$`, held in step only by a
    // doc comment demanding two selector constants stay byte-identical. Drift
    // there never failed loudly — it silently bound every ref to the wrong
    // element. A second query reintroduces exactly that hazard, so it is a
    // source rule rather than a review habit.
    const controller = readFileSync(
      resolve(repoRoot, 'packages/core/src/browser/agent-controller.ts'),
      'utf8',
    );
    const replayPort = readFileSync(
      resolve(repoRoot, 'packages/core/src/executor/step-handlers/fill-element.ts'),
      'utf8',
    );

    for (const source of [controller, replayPort]) {
      expect(source).toContain('collectComposedInteractables');
      // No handle list paired with an index minted elsewhere.
      expect(source).not.toMatch(/\.\$\$\(\s*INTERACTABLE_SELECTOR/);
      expect(source).not.toContain('selectorIndex');
    }
    // The controller's own copy of the selector — and the comment that warned
    // about keeping it byte-identical — are gone, not merely unused.
    expect(controller).not.toContain('INTERACTABLE_SELECTOR');

    // One walk implementation, not three.
    const walkers = globSync('packages/*/src/**/*.ts', { cwd: repoRoot })
      .filter((filePath) =>
        readFileSync(resolve(repoRoot, filePath), 'utf8').includes('element.shadowRoot'),
      )
      .map((filePath) => filePath.split(sep).join('/'));
    expect(walkers).toEqual(['packages/core/src/discovery/interactable-scan.ts']);
  });

  it('leaves a site named in an explanatory comment alone', async () => {
    // The same fixture carries KAYAK in its header comment as evidence for why
    // a general rule exists. AST selectors do not see comments, and that is the
    // point: the distinction is between naming a cause and branching on one.
    const fixturePath = resolve(
      repoRoot,
      'packages/core/src/_lint-fixtures/site-specific-logic.ts',
    );

    const messages = await lintMessagesFor(fixturePath);
    const fromComment = messages.filter(
      (message) => message.ruleId === 'no-restricted-syntax' && (message.line ?? 0) < 10,
    );

    expect(fromComment).toHaveLength(0);
  }, 30_000);

  it('keeps recovery to one runner and one declared plan builder per family', () => {
    const files = globSync('packages/*/src/**/*.ts', { cwd: repoRoot });
    const sources = files.map((filePath) => ({
      filePath: filePath.split(sep).join('/'),
      source: readFileSync(resolve(repoRoot, filePath), 'utf8'),
    }));
    const all = sources.map((entry) => entry.source).join('\n');
    expect(all.match(/export async function runEscalationPlan\b/g) ?? []).toHaveLength(1);

    for (const deleted of [
      /function withAttempts\b/,
      /function driveWithFallback\b/,
      /function withOpenProbe\b/,
      /function fieldHealingPort\b/,
      /function mergeLedger\b/,
      /function mergedAttempts\b/,
      /function watchAndSelect\b/,
    ]) {
      expect(all).not.toMatch(deleted);
    }

    const builders: Readonly<Record<string, string>> = {
      text: 'buildTextPlan',
      combobox: 'buildComboboxPlan',
      date: 'buildDriverPlan',
      option: 'buildDriverPlan',
      field: 'buildFieldFillPlan',
      click: 'buildClickPlan',
    };
    expect(Object.keys(builders)).toEqual(['text', 'combobox', 'date', 'option', 'field', 'click']);
    for (const builder of new Set(Object.values(builders))) {
      expect(all.match(new RegExp(`export function ${builder}\\b`, 'g')) ?? []).toHaveLength(1);
    }
  });

  it('keeps deterministic fill replay on the core engine and free of model calls', () => {
    const source = readFileSync(
      resolve(repoRoot, 'packages/core/src/executor/step-handlers/fill-element.ts'),
      'utf8',
    );
    expect(source).toContain('fillField(');
    expect(source).not.toMatch(/llm|languageModel|generateText|chatCompletion/i);
  });
});
