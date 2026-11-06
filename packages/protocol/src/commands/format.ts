/**
 * Shell-aware rendering of a {@link CommandInvocation} for display and Copy.
 *
 * Formatting never feeds execution: workers are spawned shell-free from
 * `{path, argv}`. A command shown in the app must paste and run correctly in
 * bash, PowerShell 5.1 and cmd, or say plainly why it cannot (cmd), and a
 * secret value is never rendered at all. The real-shell suite (FEAT-062
 * TASK-011) is the authority over these rules.
 */

import { expandOptions } from './expand.js';
import { parseInvocation, type CommandInvocation } from './invocation.js';
import { COMMAND_REGISTRY, findLeaf } from './registry.js';
import type { CommandRegistry, LeafEntry } from './schema.js';

/** A shell to format for. */
export type Shell = 'posix' | 'powershell' | 'cmd';

export type FormatResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: 'shell_unrepresentable' | 'secret_input';
      readonly detail: string;
    };

export interface FormatOptions {
  /** The program, as one token or several (e.g. `['node', '/abs/bin.js']`). Default `yantra`. */
  readonly program?: string | readonly string[];
  readonly registry?: CommandRegistry;
}

/** The shell a copied command targets by default: PowerShell on Windows, POSIX elsewhere. */
export function defaultShellFor(platform: string): Shell {
  return platform === 'win32' ? 'powershell' : 'posix';
}

// ---------------------------------------------------------------- POSIX

const POSIX_BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One POSIX shell word: bare when safe, otherwise single-quoted (`'` as `'\''`). */
export function quotePosix(token: string): string {
  if (POSIX_BARE.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- MSVCRT

/**
 * Encodes a value so the MSVCRT/`CommandLineToArgvW` parse of the child's
 * command line yields it back: each `"` is escaped as `\"` with the
 * backslashes before it doubled, and when the value will be wrapped in
 * quotes, trailing backslashes are doubled so they cannot escape the closing
 * quote.
 */
function escapeMsvcrt(value: string, wrapped: boolean): string {
  let out = '';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  out += '\\'.repeat(wrapped ? backslashes * 2 : backslashes);
  return out;
}

const WHITESPACE = /\s/;

// ---------------------------------------------------------------- PowerShell 5.1

const POWERSHELL_BARE = /^(?:--?[A-Za-z][A-Za-z0-9-]*|[A-Za-z0-9_][A-Za-z0-9_./:=+-]*)$/;

/**
 * One PowerShell 5.1 argument for a native command. PowerShell passes a
 * string through unchanged unless it holds unquoted whitespace, in which case
 * it wraps it in `"…"` without escaping anything, and it drops an empty
 * string. So the value is first encoded for the child's MSVCRT parse, then
 * written as a single-quoted PowerShell literal (`'` as `''`); an empty value
 * becomes `'""'`.
 */
export function quotePowerShell(token: string): string {
  if (token === '') return `'""'`;
  if (POWERSHELL_BARE.test(token) && token !== '--') return token;
  const encoded = escapeMsvcrt(token, WHITESPACE.test(token));
  return `'${encoded.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------- cmd

const CMD_NEEDS_QUOTES = /[\s&|<>()^,;=]/;

/** Why cmd cannot carry `token`, or `null` when it can. */
function cmdProblem(token: string): string | null {
  if (/[\r\n]/.test(token)) return 'a line break, which cmd cannot carry in an argument';
  if (token.includes('"')) return 'a double quote, which cmd cannot escape reliably';
  if (token.includes('%')) return 'a percent sign, which cmd expands as a variable';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(token)) {
    return 'a control character';
  }
  return null;
}

/** One cmd argument: double-quoted when it holds whitespace or a cmd metacharacter. */
export function quoteCmd(token: string): string {
  if (token === '') return '""';
  if (!CMD_NEEDS_QUOTES.test(token)) return token;
  return `"${escapeMsvcrt(token, true)}"`;
}

// ---------------------------------------------------------------- secrets

/** True when the invocation gives a value to any `secret-input` argument or option. */
function carriesSecret(
  invocation: CommandInvocation,
  registry: CommandRegistry,
): { readonly secret: boolean; readonly detail: string } {
  const entry: LeafEntry | undefined = findLeaf(invocation.path, registry);
  if (entry === undefined) return { secret: false, detail: '' };
  const secretArguments = entry.arguments.filter((a) => a.input.kind === 'secret-input');
  const secretOptions = expandOptions(entry, registry.option_groups).filter(
    (o) => o.input.kind === 'secret-input',
  );
  if (secretArguments.length === 0 && secretOptions.length === 0) {
    return { secret: false, detail: '' };
  }
  const parsed = parseInvocation([...invocation.path, ...invocation.argv], {
    cwd: invocation.cwd,
    invocationId: invocation.invocation_id,
    registry,
  });
  if (!parsed.isOk) {
    // Cannot tell where the value is, so refuse rather than risk printing it.
    return { secret: true, detail: `${entry.id} takes a secret and the invocation does not parse` };
  }
  const named = [
    ...secretArguments
      .filter((a) => parsed.value.arguments[a.name] !== undefined)
      .map((a) => a.name),
    ...secretOptions.filter((o) => parsed.value.explicit.includes(o.attribute)).map((o) => o.long),
  ];
  return named.length === 0
    ? { secret: false, detail: '' }
    : { secret: true, detail: `${named.join(', ')} carries a secret value` };
}

// ---------------------------------------------------------------- format

/**
 * Renders `program`, the canonical path and argv as one command line for
 * `shell`. Refuses with `secret_input` for every shell when a secret value is
 * present, and with `shell_unrepresentable` when cmd cannot carry a token.
 */
export function formatInvocation(
  invocation: CommandInvocation,
  shell: Shell,
  options: FormatOptions = {},
): FormatResult {
  const registry = options.registry ?? COMMAND_REGISTRY;
  const secret = carriesSecret(invocation, registry);
  if (secret.secret) return { ok: false, reason: 'secret_input', detail: secret.detail };

  const program =
    typeof options.program === 'string' ? [options.program] : [...(options.program ?? ['yantra'])];
  const tokens = [...invocation.path, ...invocation.argv];

  if (shell === 'posix') {
    return { ok: true, text: [...program, ...tokens].map(quotePosix).join(' ') };
  }
  if (shell === 'powershell') {
    const head = program.map(quotePowerShell);
    // A quoted command name is a string expression; the call operator runs it.
    const call = head[0] !== program[0] ? ['&', ...head] : head;
    return { ok: true, text: [...call, ...tokens.map(quotePowerShell)].join(' ') };
  }
  for (const [index, token] of [...program, ...tokens].entries()) {
    const problem = cmdProblem(token);
    if (problem !== null) {
      const where =
        index < program.length
          ? 'the program path'
          : `argument ${String(index - program.length + 1)}`;
      return {
        ok: false,
        reason: 'shell_unrepresentable',
        detail: `cmd cannot run this command: ${where} contains ${problem}`,
      };
    }
  }
  return { ok: true, text: [...program, ...tokens].map(quoteCmd).join(' ') };
}
