// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import vitestPlugin from 'eslint-plugin-vitest';
import prettierConfig from 'eslint-config-prettier';

const CORE_BOUNDARY_MESSAGE =
  '@yantra/core must not import from @yantra/agent (architectural boundary, see plan_agentic.md §3: protocol -> core -> agent -> cli)';
const PI_AGENT_CORE_BOUNDARY_MESSAGE =
  'Direct pi-agent-core imports are forbidden outside packages/agent. Use the LLMClient interface.';
const PI_SDK_BOUNDARY_MESSAGE =
  '@earendil-works/pi-coding-agent may only be imported under packages/agent/src/adapters/pi/ (plan_agentic.md §3). Use the AgentProvider seam.';

/**
 * Site names that must never appear in a value the code can evaluate.
 *
 * Not exhaustive, and not meant to be: it is a tripwire for the habit, not a
 * blocklist of the web. Extend it whenever a review catches a new one.
 *
 * Exported so the task-fidelity fixture census (`e2e/task-fidelity`) reads this
 * one list instead of a copy that would drift from it.
 */
export const SITE_TOKEN_SOURCE =
  'expedia|kayak|priceline|orbitz|skyscanner|booking[.]com|trip[.]com|google flights|google travel|autotrader';
const SITE_SPECIFIC_LOGIC_MESSAGE =
  'Website-specific logic is forbidden: automation must work from generic structural signals ' +
  '(ARIA roles, accessible names, widget shape, observed DOM state), never from a named site. ' +
  'A site name may appear in a comment as evidence for a general rule, never in a value the ' +
  'code evaluates. See .spec-lite/memory.md -> General.';

const UI_DEPENDENCY_DIRECTION =
  'see plan_ui.md §8 "Dependency direction": packages/ui depends on @yantra/protocol for types ' +
  'only, and never imports core, agent or Node built-ins.';

/**
 * Import restrictions for Drshya (`packages/ui`) and app (`apps/web`) browser
 * code, except the icon rule.
 *
 * Flat config *replaces* a rule's options for matching files, so the icon
 * registry override below restates these patterns from this one value rather
 * than from a hand-written subset.
 */
const UI_BOUNDARY_PATTERNS = [
  {
    group: ['node:*', 'node:*/**'],
    message: `Drshya is browser code and must not import Node built-ins (${UI_DEPENDENCY_DIRECTION})`,
  },
  {
    group: [
      '@yantra/core',
      '@yantra/core/*',
      '@yantra/agent',
      '@yantra/agent/*',
      '@yantra/cli',
      '@yantra/cli/*',
    ],
    message: `Drshya must not import Yantra engine packages (${UI_DEPENDENCY_DIRECTION})`,
  },
  {
    group: ['@earendil-works/*'],
    message: `Drshya must not import the agent provider SDK (${UI_DEPENDENCY_DIRECTION})`,
  },
  {
    group: ['@yantra/protocol', '@yantra/protocol/*'],
    allowTypeImports: true,
    message: `Drshya may import @yantra/protocol with \`import type\` only (${UI_DEPENDENCY_DIRECTION})`,
  },
];

/** Icons come from the semantic registry only (plan_ui.md §9). */
const LUCIDE_PATTERN = {
  group: ['lucide-react', 'lucide-react/*'],
  message:
    'Import icons from the Drshya registry (`<Icon name=…>`), never `lucide-react` directly (plan_ui.md §9). Only packages/ui/src/icons/registry.tsx may import it.',
};

/** Every browser-code import restriction, the icon rule included. */
export const UI_IMPORT_RESTRICTIONS = { patterns: [...UI_BOUNDARY_PATTERNS, LUCIDE_PATTERN] };

/** The same restrictions without the icon rule, for the registry file alone. */
export const UI_REGISTRY_IMPORT_RESTRICTIONS = { patterns: [...UI_BOUNDARY_PATTERNS] };

/** The site-name tripwire, shared by every block that sets no-restricted-syntax. */
export const SITE_SPECIFIC_SELECTORS = [
  {
    selector: `Literal[value=/${SITE_TOKEN_SOURCE}/i]`,
    message: SITE_SPECIFIC_LOGIC_MESSAGE,
  },
  {
    selector: `TemplateElement[value.raw=/${SITE_TOKEN_SOURCE}/i]`,
    message: SITE_SPECIFIC_LOGIC_MESSAGE,
  },
];

/** Core writers must stage to a unique sibling even when no RMW lock is needed. */
export const FIXED_TEMP_SELECTORS = [
  {
    selector:
      'TemplateLiteral[expressions.length=1] > TemplateElement[tail=true][value.raw=/^\\.[\\w.-]*tmp$/]',
    message: 'Fixed temporary names are forbidden: use uniqueTempPath or writeFileAtomic.',
  },
  {
    selector: "BinaryExpression[operator='+'][right.type='Literal'][right.value=/\\.tmp$/]",
    message: 'Fixed temporary names are forbidden: use uniqueTempPath or writeFileAtomic.',
  },
];

const DRSHYA_RULE = 'See plan_ui.md §9 and .spec-lite/memory.md -> General (Drshya).';

/**
 * Utility prefixes that take a color. `border-x`, `border-t` and friends are
 * spelled out; `(?:^|[\s:])` lets variant prefixes (`hover:`, `dark:`) match.
 */
const COLOR_UTILITY_PREFIX =
  '(?:bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|shadow|inset-shadow|drop-shadow|divide|placeholder|caret|accent)';

/** Tailwind palette names and Drshya primitive ramps; none is a semantic token. */
const PALETTE_NAME =
  '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white|fog|ion|jade|crimson|rani)';

// esquery regex literals cannot contain "/", so the opacity slash is \u002F.
const RAW_PALETTE_SOURCE = `(?:^|[\\s:])${COLOR_UTILITY_PREFIX}-${PALETTE_NAME}(?=$|[\\s\\u002F-])`;
const ARBITRARY_COLOR_SOURCE = '-\\[(?:#|(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\\()';
const HEX_COLOR_SOURCE = '^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$';
const COLOR_FUNCTION_SOURCE = '(?:oklch|oklab|rgba?|hsla?)\\(';

const RAW_PALETTE_MESSAGE = `Raw palette utility: style with Drshya semantic utilities (bg-surface, text-ink-2, border-rule), never a Tailwind palette or primitive ramp. ${DRSHYA_RULE}`;
const ARBITRARY_COLOR_MESSAGE = `Arbitrary color value: add or use a semantic token instead of -[#…] or -[oklch(…)]. ${DRSHYA_RULE}`;
const COLOR_LITERAL_MESSAGE = `Color literal outside the token data: colors live in packages/ui/src/tokens and reach components as semantic utilities. ${DRSHYA_RULE}`;
const INLINE_STYLE_MESSAGE = `Inline style: only custom properties ('--progress': '40%') may be set inline; everything else is a utility. ${DRSHYA_RULE}`;
const INNER_HTML_MESSAGE = `dangerouslySetInnerHTML is forbidden: page-derived text is untrusted and React escaping is the only renderer (plan_ui.md §3, §7). ${DRSHYA_RULE}`;

/** Drshya styling selectors for packages/ui and apps/web (FEAT-061 TASK-006). */
export const DRSHYA_STYLE_SELECTORS = [
  { selector: `Literal[value=/${RAW_PALETTE_SOURCE}/i]`, message: RAW_PALETTE_MESSAGE },
  { selector: `TemplateElement[value.raw=/${RAW_PALETTE_SOURCE}/i]`, message: RAW_PALETTE_MESSAGE },
  { selector: `Literal[value=/${ARBITRARY_COLOR_SOURCE}/i]`, message: ARBITRARY_COLOR_MESSAGE },
  {
    selector: `TemplateElement[value.raw=/${ARBITRARY_COLOR_SOURCE}/i]`,
    message: ARBITRARY_COLOR_MESSAGE,
  },
  { selector: `Literal[value=/${HEX_COLOR_SOURCE}/i]`, message: COLOR_LITERAL_MESSAGE },
  { selector: `Literal[value=/${COLOR_FUNCTION_SOURCE}/i]`, message: COLOR_LITERAL_MESSAGE },
  {
    selector: `TemplateElement[value.raw=/${COLOR_FUNCTION_SOURCE}/i]`,
    message: COLOR_LITERAL_MESSAGE,
  },
  {
    selector:
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression > Property[key.type="Identifier"]',
    message: INLINE_STYLE_MESSAGE,
  },
  {
    selector:
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression > Property[key.type="Literal"]:not([key.value=/^--/])',
    message: INLINE_STYLE_MESSAGE,
  },
  {
    selector:
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression > SpreadElement',
    message: INLINE_STYLE_MESSAGE,
  },
  {
    selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
    message: INNER_HTML_MESSAGE,
  },
];

export const HANDLER_PURITY_SELECTORS = [
  {
    selector:
      'MemberExpression[object.name="process"][property.name=/^(exit|exitCode|stdin|stdout|stderr|env|cwd|chdir|on|once|off|argv|kill)$/]',
    message: 'Handler purity: use CommandContext instead of process capabilities.',
  },
  {
    selector:
      'MemberExpression[object.name="process"][computed=true][property.value=/^(exit|exitCode|stdin|stdout|stderr|env|cwd|chdir|on|once|off|argv|kill)$/]',
    message: 'Handler purity: use CommandContext instead of process capabilities.',
  },
  {
    selector: 'MemberExpression[property.name="isTTY"]',
    message: 'Handler purity: use context.isInteractive or output.colorCapable.',
  },
  {
    selector: 'NewExpression[callee.name="CLIConnectorIO"]',
    message: 'Handler purity: use context.connector.',
  },
  {
    selector: 'MemberExpression[object.name="console"]',
    message: 'Handler purity: use context.output or logger.',
  },
  {
    selector: 'ImportDeclaration[source.value="prompts"]',
    message: 'Handler purity: use context.input.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/_lint-fixtures/**',
      '.claude/**',
      // Separate feature checkouts have their own lint gates and TS projects.
      '.worktrees/**',
      // Task-fidelity harness output (scorecards, run directories); gitignored.
      'e2e/task-fidelity/.out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/no-default-export': 'error',
      'import/order': [
        'error',
        {
          alphabetize: { order: 'asc', caseInsensitive: true },
          'newlines-between': 'always',
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'warn',
    },
  },

  // Vitest plugin for spec files.
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx'],
    plugins: { vitest: vitestPlugin },
    rules: {
      ...vitestPlugin.configs.recommended.rules,
      // Property-based tests often assert via fc.assert(...) without direct expect() calls.
      'vitest/expect-expect': 'off',
    },
  },

  // Trust-boundary packages: no `any`, even with a comment.
  {
    files: ['packages/protocol/**/*.ts', 'packages/agent/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // Architectural boundary 1 (plan_agentic.md §3): the Pi SDK is confined to
  // packages/agent/src/adapters/pi/. Everywhere else in packages/agent it is
  // restricted; the adapter directory (and its mirrored tests) un-restrict it
  // below.
  {
    files: ['packages/agent/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-coding-agent/*'],
              message: PI_SDK_BOUNDARY_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/agent/src/adapters/pi/**/*.ts', 'packages/agent/tests/adapters/pi/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Architectural boundary 2: no agent SDK imports outside packages/agent
  // (legacy pi-agent-core name kept until FEAT-029 removes the last mention).
  {
    files: [
      'packages/protocol/**/*.ts',
      'packages/test-helpers/**/*.ts',
      'apps/**/*.ts',
      'e2e/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pi-agent-core', 'pi-agent-core/*'],
              message: PI_AGENT_CORE_BOUNDARY_MESSAGE,
            },
            {
              group: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-coding-agent/*'],
              message: PI_SDK_BOUNDARY_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // Architectural boundary 3: packages/core cannot import @yantra/agent
  // (dependency direction is protocol -> core -> agent -> cli). Stated as one
  // combined rule because a later flat-config block replaces, not merges,
  // `no-restricted-imports` options for matching files.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@yantra/agent', '@yantra/agent/*', '**/packages/agent/**'],
              message: CORE_BOUNDARY_MESSAGE,
            },
            {
              group: ['pi-agent-core', 'pi-agent-core/*'],
              message: PI_AGENT_CORE_BOUNDARY_MESSAGE,
            },
            {
              group: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-coding-agent/*'],
              message: PI_SDK_BOUNDARY_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // Standing rule: browser automation must never branch on a particular site.
  //
  // There are millions of websites; a tool that works only because someone
  // hand-tuned it for the top ten has failed at its job. Everything must work
  // from generic structural signals — ARIA roles, accessible names, widget
  // shape, observed DOM state.
  //
  // The selectors match AST nodes, so a site named in an explanatory comment
  // stays legal, and that is deliberate: naming the site that *demonstrated* a
  // general defect is valuable evidence. What is forbidden is a site name the
  // code can evaluate — a literal, a template chunk, a lookup key.
  {
    files: [
      'packages/*/src/**/*.ts',
      'apps/*/src/**/*.ts',
      'packages/*/src/**/*.tsx',
      'apps/*/src/**/*.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...SITE_SPECIFIC_SELECTORS],
    },
  },

  {
    files: ['packages/core/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...SITE_SPECIFIC_SELECTORS, ...FIXED_TEMP_SELECTORS],
    },
  },
  {
    // Tests may name sites as evidence, as before; staging names still must be unique.
    files: ['packages/core/tests/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...FIXED_TEMP_SELECTORS] },
  },

  // Drshya styling (plan_ui.md §9; memory -> General): components style only
  // through semantic utilities. The token data directory is exempt from the
  // style selectors (it defines the colors), but stays under the site rule
  // through the block above. The site selectors are restated here because a
  // later block *replaces* no-restricted-syntax options for matching files;
  // leaving them out would silently disable the site rule in packages/ui.
  {
    files: ['packages/ui/src/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'],
    ignores: ['packages/ui/src/tokens/**'],
    rules: {
      'no-restricted-syntax': ['error', ...SITE_SPECIFIC_SELECTORS, ...DRSHYA_STYLE_SELECTORS],
    },
  },

  // Drshya import boundary (plan_ui.md §8 "Dependency direction"): browser
  // code takes protocol types only, and nothing from core, agent, the provider
  // SDK or Node.
  {
    files: ['packages/ui/src/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'import/no-nodejs-modules': 'error',
      '@typescript-eslint/no-restricted-imports': ['error', UI_IMPORT_RESTRICTIONS],
    },
  },
  // The icon registry is the one file that may import lucide-react; every
  // other browser-code restriction still applies to it.
  {
    files: ['packages/ui/src/icons/registry.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', UI_REGISTRY_IMPORT_RESTRICTIONS],
    },
  },

  // Lint fixture files: they intentionally violate boundaries.
  // Excluded from build configs and only loaded by the boundary spec.
  {
    files: ['**/_lint-fixtures/**/*.{ts,tsx}'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  {
    files: ['apps/cli/src/**/*.ts'],
    // Process entry points own the process: the terminal adapter, the bin, and
    // the detached worker and its trampoline (FEAT-064), and the detached app
    // host (FEAT-065).
    ignores: [
      'apps/cli/src/adapters/terminal/**/*.ts',
      'apps/cli/src/bin.ts',
      'apps/cli/src/worker.ts',
      'apps/cli/src/worker/trampoline.ts',
      'apps/cli/src/ui-host.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...SITE_SPECIFIC_SELECTORS, ...HANDLER_PURITY_SELECTORS],
    },
  },

  // This negative fixture deliberately exercises the same rules as a handler.
  {
    files: ['apps/cli/src/adapters/terminal/_lint-fixtures/impure-handler.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SITE_SPECIFIC_SELECTORS, ...HANDLER_PURITY_SELECTORS],
    },
  },

  // CLI entrypoint may use console.log.
  {
    files: ['apps/cli/src/index.ts', 'apps/cli/src/bin.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Config files: turn off type-checked rules; they aren't part of a TS project.
  {
    ...tseslint.configs.disableTypeChecked,
    files: [
      '**/*.config.{js,cjs,mjs,ts}',
      '**/*.config.*.{js,cjs,mjs,ts}',
      'scripts/**/*.{js,mjs,ts}',
    ],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'import/no-default-export': 'off',
      'import/order': 'off',
    },
  },

  // Test fixtures executed as standalone processes: they are real scripts run
  // by `node`, not modules in any package's TS project, so type-aware rules
  // have no program to resolve them against.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['**/tests/**/fixtures/**/*.{js,mjs,cjs}', 'e2e/fixtures/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly' },
      // No TS program covers them, so the project service has nothing to resolve.
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'import/no-default-export': 'off',
      'import/order': 'off',
    },
  },

  // FEAT-064 spike S2: a throwaway evidence harness of standalone Node scripts (TASK-001).
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['e2e/spikes/**/*.{js,mjs,cjs}', 'e2e/fixtures/run-ownership/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        TextDecoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
      },
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'import/no-default-export': 'off',
      'no-console': 'off',
    },
  },

  {
    ...tseslint.configs.disableTypeChecked,
    files: ['eslint.config.js', 'vitest.workspace.ts'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'import/no-default-export': 'off',
      'import/order': 'off',
    },
  },

  // Protocol scripts/tests/generated files are outside package tsconfig project includes.
  {
    ...tseslint.configs.disableTypeChecked,
    files: [
      'packages/protocol/generated/**/*.ts',
      'packages/protocol/scripts/**/*.ts',
      'packages/protocol/tests/**/*.ts',
    ],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },

  // Agent tests are outside the package tsconfig project includes.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['packages/agent/tests/**/*.ts'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },

  // Core tests are outside package tsconfig includes.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['packages/core/tests/**/*.ts'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },

  // Drshya tests, the gallery dev page and the token script are outside the
  // package's source project; `tsconfig.tests.json` typechecks them instead.
  {
    ...tseslint.configs.disableTypeChecked,
    files: [
      'packages/ui/tests/**/*.{ts,tsx}',
      'packages/ui/gallery/**/*.{ts,tsx}',
      'packages/ui/scripts/**/*.ts',
    ],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },

  // CLI and test-helpers tests are outside package tsconfig includes.
  {
    ...tseslint.configs.disableTypeChecked,
    files: [
      'apps/cli/tests/**/*.ts',
      'apps/cli/scripts/**/*.ts',
      'packages/test-helpers/tests/**/*.ts',
    ],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },

  prettierConfig,
);
