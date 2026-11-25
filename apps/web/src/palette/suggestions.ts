/**
 * What the command palette offers for what you typed.
 *
 * With nothing typed it shows how to start and where to go, so a first-time
 * user can see what the palette is for. As you type it searches pages, page
 * actions and `yantra` commands by their words, and offers to Ask, Research
 * or Do the text itself. Text that reads as a command ("sites add x",
 * "yantra doctor") gets a first section that says exactly what will happen
 * when you press Enter, or what is still missing.
 *
 * Pure: the component runs the command interpreter and passes its outcome in.
 */

import type { LeafEntry } from '@yantra/protocol';
import { COMMAND_REGISTRY, type TokenizeRefusal } from '@yantra/protocol/commands';
import type { CommandMenuItem } from '@yantra/ui';

import { MAIN_SECTIONS, SETTINGS_SECTION, type NavLink } from '../app/navigation.js';
import { commandTemplate } from '../generated/command-template.js';
import { SURFACE_DEFINITIONS } from '../surfaces/definitions.js';

import { freeTextOf, type PaletteOutcome } from './palette-model.js';

/** A Mission mode the palette can start. */
export type StartMode = 'ask' | 'research' | 'do' | 'run';

/** What choosing an item does. */
export type PaletteTarget =
  | { readonly kind: 'go'; readonly path: string }
  | { readonly kind: 'start'; readonly mode: StartMode; readonly goal?: string }
  | { readonly kind: 'fill'; readonly text: string }
  | { readonly kind: 'run' };

export interface PaletteItem extends CommandMenuItem {
  readonly target: PaletteTarget;
}

export interface PaletteSection {
  readonly id: string;
  readonly title: string;
  readonly items: readonly PaletteItem[];
}

const START: readonly {
  readonly mode: StartMode;
  readonly label: string;
  readonly verb: string | null;
  readonly description: string;
}[] = [
  {
    mode: 'ask',
    label: 'Ask a question',
    verb: 'Ask',
    description: 'A quick answer from web sources, with citations.',
  },
  {
    mode: 'research',
    label: 'Research a topic',
    verb: 'Research',
    description: 'A cited report built from several sources.',
  },
  {
    mode: 'do',
    label: 'Do a task on a website',
    verb: 'Do',
    description: 'Yantra works in a browser and asks you before anything risky.',
  },
  {
    mode: 'run',
    label: 'Run a saved workflow',
    verb: null,
    description: 'Replay a recorded task step by step.',
  },
];

/** What each page is for, and other words people use for it. */
const PAGE_WORDS: Readonly<Record<string, { readonly about: string; readonly words: string }>> = {
  '/mission': {
    about: 'Start a run: ask, research, do or run a workflow.',
    words: 'start new run',
  },
  '/runs': { about: 'Every run, newest first, with its result.', words: 'history results list' },
  '/inbox': { about: 'Approvals and handoffs waiting for you.', words: 'consent approve confirm' },
  '/workflows': { about: 'Saved workflows to replay or schedule.', words: 'replay recorded' },
  '/templates': { about: 'Templates that shape a run’s document.', words: 'report document' },
  '/schedules': { about: 'Workflows that run on a schedule.', words: 'cron recurring' },
  '/settings/installation': {
    about: 'Where Yantra keeps its files, and config.yaml.',
    words: 'config yaml paths settings',
  },
  '/settings/models': {
    about: 'The models Yantra can use.',
    words: 'llm provider anthropic ollama claude ai',
  },
  '/settings/credentials': {
    about: 'API keys and passwords, kept in your keychain.',
    words: 'api secret key password token keychain',
  },
  '/settings/browser': {
    about: 'The Chrome that Yantra drives.',
    words: 'chrome chromium install',
  },
  '/settings/sites': { about: 'How Yantra ranks the sites it reads.', words: 'domains ranking' },
  '/settings/data': { about: 'Where runs and workflows are stored.', words: 'storage folder disk' },
  '/settings/preferences': {
    about: 'How you like runs to behave.',
    words: 'profile prefs theme dark light timeout budget',
  },
  '/health': { about: 'Check that this machine is ready.', words: 'doctor diagnostics problems' },
  '/usage': { about: 'Tasks and cost by day.', words: 'cost spend tokens money' },
  '/daemon': { about: 'The scheduler that runs in the background.', words: 'background service' },
};

interface Page extends NavLink {
  readonly where: string | undefined;
}

/** Every page in the navigation, with where it sits. */
const PAGES: readonly Page[] = [
  ...MAIN_SECTIONS.filter((section) => section.id !== 'library').map((section) => ({
    path: section.path,
    label: section.label,
    where: undefined,
  })),
  ...MAIN_SECTIONS.flatMap((section) =>
    section.groups.flatMap((group) =>
      group.links.map((link) => ({ ...link, where: section.label })),
    ),
  ),
  ...SETTINGS_SECTION.groups.flatMap((group) =>
    group.links.map((link) => ({ ...link, where: `${SETTINGS_SECTION.label} · ${group.label}` })),
  ),
];

/** The pages shown before anything is typed. */
const FIRST_PAGES = ['/runs', '/inbox', '/workflows', '/settings/models', '/health'];

interface Action {
  readonly label: string;
  readonly page: string;
  readonly path: string;
  readonly line: string;
}

function leaf(command: string): LeafEntry | undefined {
  return COMMAND_REGISTRY.commands.find(
    (entry): entry is LeafEntry => entry.kind === 'leaf' && entry.path.join(' ') === command,
  );
}

/** Every page action, opening its form where it lives, plus the bespoke pages' main actions. */
const ACTIONS: readonly Action[] = [
  ...SURFACE_DEFINITIONS.flatMap((definition) =>
    definition.actions.flatMap((action) => {
      const entry = leaf(action.command);
      return entry === undefined
        ? []
        : [
            {
              label: action.label,
              page: definition.title,
              path: `${definition.route}?do=${encodeURIComponent(action.command)}`,
              line: commandTemplate(entry),
            },
          ];
    }),
  ),
  {
    label: 'Edit config.yaml',
    page: 'Installation',
    path: '/settings/installation?mode=raw',
    line: 'yantra config edit',
  },
  {
    label: 'Set a credential',
    page: 'Credentials',
    path: '/settings/credentials',
    line: 'yantra secret set <key>',
  },
  { label: 'Check this machine', page: 'Health', path: '/health', line: 'yantra doctor' },
];

const LEAVES: readonly LeafEntry[] = COMMAND_REGISTRY.commands.filter(
  (entry): entry is LeafEntry => entry.kind === 'leaf',
);
const COMMAND_WORDS: ReadonlySet<string> = new Set(LEAVES.map((entry) => entry.path[0] ?? ''));

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Whether a typed word matches a word: it starts it ("mod" → "models"), or
 * the word starts it and is not tiny ("models" → "model").
 */
function wordMatches(token: string, word: string): boolean {
  return word.startsWith(token) || (word.length >= 4 && token.startsWith(word));
}

/**
 * How well `query` matches: every typed word must match a word of the label
 * or of `extra`. Label words count double; a label that starts with the whole
 * query counts most. Zero means no match.
 */
export function matchScore(query: string, label: string, extra = ''): number {
  const typed = words(query);
  if (typed.length === 0) return 0;
  const labelWords = words(label);
  const all = [...labelWords, ...words(extra)];
  let score = 0;
  for (const token of typed) {
    if (labelWords.some((word) => wordMatches(token, word))) score += 2;
    else if (all.some((word) => wordMatches(token, word))) score += 1;
    else return 0;
  }
  return label.toLowerCase().startsWith(query.trim().toLowerCase()) ? score + 3 : score;
}

function best<T>(items: readonly T[], score: (item: T) => number, limit: number): T[] {
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * The command a query spells, without a leading `yantra`, or null when the
 * text reads as words rather than a command. It is a command when it starts
 * with `yantra`, is a whole command (`doctor`), or starts with a command word
 * and goes on (`sites add x`).
 */
export function commandText(query: string): string | null {
  const text = query.trim();
  if (text.length === 0) return null;
  if (/^yantra(\s|$)/u.test(text)) return text.replace(/^yantra\s*/u, '');
  if (LEAVES.some((entry) => entry.path.join(' ') === text)) return text;
  const first = text.split(/\s+/u)[0] ?? '';
  return COMMAND_WORDS.has(first) && /\s/u.test(text) ? text : null;
}

function pageItem(page: Page): PaletteItem {
  return {
    id: `go:${page.path}`,
    label: page.label,
    description: PAGE_WORDS[page.path]?.about ?? '',
    icon: 'action.go',
    ...(page.where === undefined ? {} : { hint: page.where }),
    target: { kind: 'go', path: page.path },
  };
}

function startItems(goal: string | null): PaletteItem[] {
  return START.flatMap((start) => {
    if (goal === null)
      return [
        {
          id: `start:${start.mode}`,
          label: start.label,
          description: start.description,
          icon: 'glyph.bindu' as const,
          target: { kind: 'start', mode: start.mode } as const,
        },
      ];
    if (start.verb === null) return [];
    return [
      {
        id: `start:${start.mode}`,
        label: `${start.verb} “${goal}”`,
        description: start.description,
        icon: 'glyph.bindu' as const,
        target: { kind: 'start', mode: start.mode, goal } as const,
      },
    ];
  });
}

/** Why a line was not read as one command, in words. */
const REFUSALS: Readonly<Record<TokenizeRefusal, string>> = {
  empty: 'Type a command.',
  unterminated_quote: 'A quote is opened and never closed. Close it, or take it out.',
  shell_operator: 'Pipes, redirects, & and ; are not run here. Type one command.',
  expansion: 'Variables like $HOME and $(…) are not filled in here. Type the value itself.',
  glob: 'Wildcards like * and ? are not expanded here. Put that text in quotes.',
  multiline: 'Type the command on one line.',
};

/**
 * What is wrong with a command that did not parse, in words: the parser's
 * "error: missing required argument 'domain'" reads "Still needs <domain>",
 * a required option reads as itself ("--cron"), and too many arguments says
 * to quote text with spaces.
 */
export function explainParse(messages: readonly string[], command: string): string {
  const needs: string[] = [];
  const problems: string[] = [];
  for (const message of messages) {
    const text = message.replace(/^error:\s*/u, '');
    const argument = /missing required argument '([^']+)'/u.exec(text)?.[1];
    const option = /required option '([^']+)'/u.exec(text)?.[1];
    const tooMany = /too many arguments for '[^']+'\. Expected (\d+) arguments?/u.exec(text);
    if (argument !== undefined) needs.push(`<${argument}>`);
    else if (option !== undefined)
      needs.push(option.split(/[\s,]+/u).find((part) => part.startsWith('--')) ?? option);
    else if (tooMany !== null)
      problems.push(
        `Too many words for yantra ${command}: it takes ${tooMany[1] ?? ''} ${
          tooMany[1] === '1' ? 'argument' : 'arguments'
        }. Put text with spaces in quotes.`,
      );
    else problems.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}`);
  }
  return [
    ...(needs.length === 0
      ? []
      : [`Still needs ${needs.join(' and ')}. Type it after the command.`]),
    ...problems,
  ].join(' ');
}

function readyDescription(
  outcome: Extract<PaletteOutcome, { state: 'ready' }>,
  armed: boolean,
): string {
  if (outcome.danger)
    return armed ? 'Press Enter again to run it.' : 'This changes something; you confirm first.';
  const what =
    outcome.executionClass === 'read'
      ? 'Opens the page that shows it.'
      : outcome.executionClass === 'run'
        ? 'Starts a run and opens it.'
        : 'Runs now, then opens the page it changes.';
  return [what, ...outcome.notices].join(' ');
}

const VERBS: Readonly<Record<string, string>> = { ask: 'Ask', research: 'Research', do: 'Do' };

/**
 * The plain words for a free-text run Yantra quoted itself: `Ask “…”`
 * instead of the shell-quoted line (`'"summarize today''s …"'`), which the
 * run's own terminal panel still shows.
 */
function plainRun(command: string): string | null {
  const free = freeTextOf(command);
  const verb = free === null ? undefined : VERBS[free.entry.path[0] ?? ''];
  return free === null || verb === undefined ? null : `${verb} “${free.text}”`;
}

const MISSION_MODES: ReadonlySet<string> = new Set(['ask', 'research', 'do']);

/** For `ask`, `research` and `do`: open Mission with the text, to review options first. */
function missionFirst(command: string): PaletteItem | null {
  const free = freeTextOf(command);
  const mode = free?.entry.path[0];
  if (free === null || mode === undefined || !MISSION_MODES.has(mode)) return null;
  return {
    id: 'command:mission',
    label: 'Open in Mission first',
    description: 'Review the options before it starts.',
    icon: 'action.go',
    target: { kind: 'start', mode: mode as StartMode, goal: free.text },
  };
}

function commandSection(
  command: string,
  outcome: PaletteOutcome,
  armed: boolean,
  typedLine: string,
  quoted: boolean,
): PaletteSection {
  const line = typedLine;
  const item = (description: string, isDisabled: boolean, label = line): PaletteItem => ({
    id: 'command:run',
    label,
    description,
    icon: 'action.command',
    voice: 'engine',
    isDisabled,
    target: { kind: 'run' },
  });
  const fill = (path: string): PaletteItem => {
    const entry = leaf(path);
    return {
      id: `fill:${path}`,
      label: entry === undefined ? `yantra ${path}` : commandTemplate(entry),
      description: entry?.description ?? '',
      icon: 'action.command',
      voice: 'engine',
      target: { kind: 'fill', text: `yantra ${path} ` },
    };
  };
  const items: PaletteItem[] = [];
  switch (outcome.state) {
    case 'ready': {
      const plain = quoted ? plainRun(command) : null;
      items.push(
        plain === null
          ? item(
              readyDescription(outcome, armed),
              false,
              outcome.danger && armed ? `Confirm: ${line}` : line,
            )
          : { ...item(readyDescription(outcome, armed), false, plain), voice: 'body' },
      );
      break;
    }
    case 'needs_input':
      items.push(item(explainParse(outcome.missing, outcome.command), true), fill(outcome.command));
      break;
    case 'unknown_command':
      items.push(
        item(
          outcome.suggestions.length === 0 ? 'No such command.' : 'No such command. Did you mean:',
          true,
        ),
        ...outcome.suggestions.map(fill),
      );
      break;
    case 'unknown_option':
      items.push(
        item(
          outcome.registeredOn.length === 0
            ? `${outcome.flag} is not an option of yantra ${outcome.command}.`
            : `${outcome.flag} belongs to ${outcome.registeredOn.map((path) => `yantra ${path}`).join(', ')}.`,
          true,
        ),
      );
      break;
    case 'invalid_value':
      items.push(item(outcome.expected, true));
      break;
    case 'relation_violation':
      items.push(
        item(
          `${outcome.flags[0] ?? ''} ${
            outcome.rule === 'requires' ? 'needs' : 'cannot be used with'
          } ${outcome.flags.slice(1).join(', ')}.`,
          true,
        ),
      );
      break;
    case 'exempt':
      items.push(item(outcome.reason, true));
      break;
    case 'refused_syntax':
      items.push(item(REFUSALS[outcome.reason], true));
      break;
    case 'secret_in_argv':
      items.push(item(`Not run: ${outcome.message}.`, true), {
        id: 'command:credentials',
        label: 'Set the credential in Credentials',
        description: 'The value goes straight to your keychain.',
        icon: 'action.go',
        target: { kind: 'go', path: '/settings/credentials' },
      });
      break;
  }
  const mission = missionFirst(command);
  if (mission !== null) items.push(mission);
  return { id: 'command', title: 'Command', items };
}

export interface PaletteState {
  /** The command the query spells ({@link commandText}), or null. */
  readonly command: string | null;
  /** The interpreter's outcome for {@link command}. */
  readonly outcome: PaletteOutcome | null;
  /** The dangerous command waiting for a second Enter. */
  readonly armed: boolean;
  /** The line that runs ({@link readCommand}); defaults to `yantra <command>`. */
  readonly line?: string;
  /** Yantra quoted the free text, so {@link line} differs from what was typed. */
  readonly quoted?: boolean;
}

/** The first thing that explains why nothing can run, for an Enter with nothing to act on. */
export function nothingToRun(sections: readonly PaletteSection[]): string | null {
  const items = sections.flatMap((section) => section.items);
  if (items.some((item) => item.isDisabled !== true)) return null;
  return items.find((item) => item.description !== undefined)?.description ?? null;
}

/** The palette's sections for `query`; only non-empty ones. */
export function paletteSections(query: string, state: PaletteState): PaletteSection[] {
  const text = query.trim();
  if (text.length === 0) {
    return [
      { id: 'start', title: 'Start', items: startItems(null) },
      {
        id: 'go',
        title: 'Go to',
        items: FIRST_PAGES.flatMap((path) => {
          const page = PAGES.find((item) => item.path === path);
          return page === undefined ? [] : [pageItem(page)];
        }),
      },
    ];
  }
  const pages = best(
    PAGES,
    (page) =>
      matchScore(text, page.label, `${page.where ?? ''} ${PAGE_WORDS[page.path]?.words ?? ''}`),
    5,
  ).map(pageItem);
  const actions = best(ACTIONS, (action) => matchScore(text, action.label, action.line), 5).map(
    (action): PaletteItem => ({
      id: `action:${action.path}`,
      label: action.label,
      description: action.line,
      icon: 'action.go',
      hint: action.page,
      target: { kind: 'go', path: action.path },
    }),
  );
  const commands =
    state.command === null
      ? best(LEAVES, (entry) => matchScore(text, entry.path.join(' '), entry.description), 4).map(
          (entry): PaletteItem => ({
            id: `fill:${entry.path.join(' ')}`,
            label: commandTemplate(entry),
            description: entry.description,
            icon: 'action.command',
            voice: 'engine',
            target: { kind: 'fill', text: `yantra ${entry.path.join(' ')} ` },
          }),
        )
      : [];
  const start =
    state.command === null
      ? { id: 'start', title: 'Start with this', items: startItems(text) }
      : null;
  const found: PaletteSection[] = [
    { id: 'go', title: 'Go to', items: pages },
    { id: 'actions', title: 'Actions', items: actions },
    { id: 'commands', title: 'Commands', items: commands },
  ];
  // Several words read as a goal: offer to start with it first.
  const ordered =
    start === null ? found : words(text).length >= 3 ? [start, ...found] : [...found, start];
  const sections =
    state.command !== null && state.outcome !== null
      ? [
          commandSection(
            state.command,
            state.outcome,
            state.armed,
            state.line ?? `yantra ${state.command.trim()}`,
            state.quoted === true,
          ),
          ...ordered,
        ]
      : ordered;
  return sections.filter((section) => section.items.length > 0);
}
