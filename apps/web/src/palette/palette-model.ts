import type { CommandInvocation, CommandRegistry, ExecutionClass } from '@yantra/protocol';
import {
  COMMAND_REGISTRY,
  createInvocationId,
  expandOptions,
  parseInvocation,
  quotePosix,
  quotePowerShell,
  tokenizeCommandLine,
  type LeafEntry,
  type Shell,
  type TokenizeRefusal,
} from '@yantra/protocol/commands';

import type { ParityManifest } from '../parity/types.js';

export type PaletteOutcome =
  | {
      readonly state: 'ready';
      readonly command: string;
      readonly invocation: CommandInvocation;
      readonly executionClass: ExecutionClass;
      readonly effect: 'none' | 'local' | 'external';
      readonly danger: boolean;
      readonly notices: readonly string[];
    }
  | { readonly state: 'needs_input'; readonly command: string; readonly missing: readonly string[] }
  | {
      readonly state: 'unknown_command';
      readonly typed: string;
      readonly suggestions: readonly string[];
    }
  | {
      readonly state: 'unknown_option';
      readonly command: string;
      readonly flag: string;
      readonly registeredOn: readonly string[];
    }
  | {
      readonly state: 'invalid_value';
      readonly command: string;
      readonly flag: string;
      readonly value: string;
      readonly expected: string;
    }
  | {
      readonly state: 'relation_violation';
      readonly command: string;
      readonly flags: readonly string[];
      readonly rule: 'requires' | 'conflicts';
    }
  | { readonly state: 'exempt'; readonly command: string; readonly reason: string }
  | { readonly state: 'refused_syntax'; readonly reason: TokenizeRefusal; readonly at: number }
  | { readonly state: 'secret_in_argv'; readonly command: string; readonly message: string };

const SECRET_IN_ARGV_MESSAGE =
  'secret values are never accepted in argv because shell history and process listings can expose them';

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

const paths = (registry: CommandRegistry): string[] =>
  registry.commands.filter((entry) => entry.kind === 'leaf').map((entry) => entry.path.join(' '));

export function suggestionsFor(
  typed: string,
  registry: CommandRegistry = COMMAND_REGISTRY,
): string[] {
  return paths(registry)
    .map((path) => ({ path, d: distance(typed, path) }))
    .sort((a, b) => a.d - b.d || a.path.localeCompare(b.path))
    .slice(0, 3)
    .map((item) => item.path);
}

/**
 * A run command whose one argument is free text: `ask <query>`,
 * `research <topic>`, `do <goal>`. Everything typed after it is that text.
 */
export function isFreeTextCommand(entry: LeafEntry): boolean {
  const [only, ...others] = entry.arguments;
  return (
    entry.execution.default === 'run' &&
    only !== undefined &&
    others.length === 0 &&
    only.required &&
    !only.variadic &&
    only.input.kind === 'text'
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The free-text command `command` starts with, and the text typed after it
 * (without one pair of quotes around it, or an opening quote never closed),
 * or null when it is no such command or the text carries options.
 */
export function freeTextOf(
  command: string,
  registry: CommandRegistry = COMMAND_REGISTRY,
): { readonly entry: LeafEntry; readonly text: string } | null {
  const line = command.trim();
  for (const entry of registry.commands) {
    if (entry.kind !== 'leaf' || !isFreeTextCommand(entry)) continue;
    const head = new RegExp(`^${entry.path.map(escapeRegExp).join('\\s+')}(?:\\s+|$)`, 'u');
    if (!head.test(line)) continue;
    let text = line.replace(head, '').trim();
    // An option (`--depth 3`) means the person is writing a command line: leave it to them.
    if (text.length === 0 || /(^|\s)-/u.test(text)) return null;
    const paired = /^(["'])([\s\S]*)\1$/u.exec(text);
    if (paired !== null) text = paired[2] ?? '';
    else if (/^["']/u.test(text)) text = text.slice(1);
    return text.trim().length === 0 ? null : { entry, text: text.trim() };
  }
  return null;
}

/** What the palette makes of a command line, and the exact line it would run. */
export interface PaletteReading {
  readonly outcome: PaletteOutcome;
  /** The line shown and run, `yantra …`. */
  readonly line: string;
  /** Yantra quoted the free text itself, so the line differs from what was typed. */
  readonly quoted: boolean;
}

/**
 * Interprets `command` the way a terminal would, then forgives the one thing
 * a person should not need to know about: quoting a question. When `yantra
 * ask summarize today's stock market` does not parse (an apostrophe opens a
 * quote; four words are four arguments; `?` is a glob), and the command
 * takes one free-text argument, the rest of the line is quoted for the
 * shell and read again.
 */
export function readCommand(
  command: string,
  shell: Shell,
  registry: CommandRegistry = COMMAND_REGISTRY,
  manifest: ParityManifest,
): PaletteReading {
  const outcome = interpret(command, shell, registry, manifest);
  const typed = { outcome, line: `yantra ${command.trim()}`, quoted: false };
  const unparsed =
    outcome.state === 'refused_syntax' ||
    (outcome.state === 'needs_input' &&
      outcome.missing.some((message) => message.includes('too many arguments')));
  if (!unparsed) return typed;
  const free = freeTextOf(command, registry);
  if (free === null) return typed;
  const quote = shell === 'powershell' ? quotePowerShell : quotePosix;
  const rebuilt = `${free.entry.path.join(' ')} ${quote(free.text)}`;
  const retried = interpret(rebuilt, shell, registry, manifest);
  return retried.state === 'ready'
    ? { outcome: retried, line: `yantra ${rebuilt}`, quoted: true }
    : typed;
}

export function interpret(
  text: string,
  shell: Shell,
  registry: CommandRegistry = COMMAND_REGISTRY,
  manifest: ParityManifest,
): PaletteOutcome {
  const tokenized = tokenizeCommandLine(text, shell);
  if (!tokenized.ok) return { state: 'refused_syntax', reason: tokenized.reason, at: tokenized.at };
  const argv = [...tokenized.argv];
  const matching = registry.commands
    .filter(
      (entry): entry is LeafEntry =>
        entry.kind === 'leaf' && entry.path.every((part, index) => argv[index] === part),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (matching === undefined) {
    const typed = argv.slice(0, 2).join(' ');
    return { state: 'unknown_command', typed, suggestions: suggestionsFor(typed, registry) };
  }
  const command = matching.path.join(' ');
  const positionalsAfterPath = argv
    .slice(matching.path.length)
    .filter((token) => !token.startsWith('-'));
  if (matching.id === 'secret.set' && positionalsAfterPath.length > 1)
    return { state: 'secret_in_argv', command, message: SECRET_IN_ARGV_MESSAGE };
  const parsed = parseInvocation(argv, { cwd: '/', invocationId: createInvocationId(), registry });
  if (!parsed.isOk) {
    const token =
      parsed.error.token_index === undefined ? '' : (argv[parsed.error.token_index] ?? '');
    if (parsed.error.code === 'missing_argument' || parsed.error.code === 'missing_required_option')
      return { state: 'needs_input', command, missing: [parsed.error.message] };
    if (parsed.error.code === 'unknown_option') {
      const flag = token.split('=')[0]!;
      const registeredOn = registry.commands
        .filter(
          (entry) =>
            entry.kind === 'leaf' &&
            expandOptions(entry, registry.option_groups).some((option) => option.long === flag),
        )
        .map((entry) => entry.path.join(' '));
      return { state: 'unknown_option', command, flag, registeredOn };
    }
    if (parsed.error.code === 'invalid_choice')
      return {
        state: 'invalid_value',
        command,
        flag: token,
        value: token,
        expected: parsed.error.message,
      };
    return { state: 'needs_input', command, missing: [parsed.error.message] };
  }
  for (const relation of matching.relations) {
    const explicit = new Set(parsed.value.explicit);
    const option = expandOptions(matching, registry.option_groups).find(
      (item) => item.long === relation.option,
    );
    if (option === undefined || !explicit.has(option.attribute)) continue;
    const related = relation.with.filter((flag) => {
      const found = expandOptions(matching, registry.option_groups).find(
        (item) => item.long === flag,
      );
      return found !== undefined && explicit.has(found.attribute);
    });
    if (
      (relation.kind === 'conflicts' && related.length > 0) ||
      (relation.kind === 'requires' && related.length === 0)
    )
      return {
        state: 'relation_violation',
        command,
        flags: [relation.option, ...relation.with],
        rule: relation.kind,
      };
  }
  const target = manifest.commands[command];
  if (target?.kind === 'exemption') return { state: 'exempt', command, reason: target.reason };
  const notices: string[] = [];
  if (argv.includes('--json')) notices.push('The app shows structured results itself.');
  if (argv.includes('--open')) notices.push('The app opens results itself.');
  return {
    state: 'ready',
    command,
    invocation: parsed.value.invocation,
    executionClass: parsed.value.execution,
    effect: matching.effect,
    danger: matching.danger.level === 'confirm',
    notices,
  };
}
