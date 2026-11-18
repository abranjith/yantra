/**
 * Shell-aware tokenizing of one typed command line (FEAT-070 TASK-001): the
 * inverse of {@link formatInvocation}. The palette accepts what a terminal
 * user would type, so this module turns a line written for POSIX shells,
 * PowerShell 5.1 or cmd back into the argv that program would receive.
 *
 * It never runs a shell and never expands anything: a line that would need a
 * shell to mean something (a pipe, a variable, a glob, a second line) is
 * refused with a closed reason and the character index to blame. It sits
 * beside `format.ts` so one module pair owns each shell's grammar; nothing
 * else may restate shell quoting (memory → Coding Standards).
 *
 * Browser-safe: no Node built-ins.
 */

import type { Shell } from './format.js';

/** Why a line cannot be tokenized. Closed: each value has one explanation in the palette. */
export type TokenizeRefusal =
  'empty' | 'unterminated_quote' | 'shell_operator' | 'expansion' | 'glob' | 'multiline';

/** Every refusal, in a stable order. */
export const TOKENIZE_REFUSALS: readonly TokenizeRefusal[] = [
  'empty',
  'unterminated_quote',
  'shell_operator',
  'expansion',
  'glob',
  'multiline',
];

/** The tokens the program would receive, or why the line is refused. */
export type TokenizeResult =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: TokenizeRefusal; readonly at: number };

class Refused extends Error {
  public constructor(
    public readonly reason: TokenizeRefusal,
    public readonly at: number,
  ) {
    super(reason);
    this.name = 'Refused';
  }
}

const refuse = (reason: TokenizeRefusal, at: number): never => {
  throw new Refused(reason, at);
};

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t';

// ---------------------------------------------------------------- POSIX

const POSIX_OPERATORS = '|;&<>()';
const POSIX_GLOBS = '*?[';

function tokenizePosix(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (isBlank(c)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      continue;
    }
    const wordStart = !inWord;
    inWord = true;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) refuse('unterminated_quote', i);
      current += line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      const open = i;
      i += 1;
      for (;;) {
        if (i >= line.length) refuse('unterminated_quote', open);
        const d = line[i]!;
        if (d === '"') break;
        if (d === '\\' && '$`"\\'.includes(line[i + 1] ?? '')) {
          current += line[i + 1];
          i += 2;
          continue;
        }
        if (d === '$' || d === '`') refuse('expansion', i);
        current += d;
        i += 1;
      }
    } else if (c === '\\') {
      if (i + 1 >= line.length) {
        current += c;
      } else {
        current += line[i + 1];
        i += 1;
      }
    } else if (c === '$' || c === '`') {
      refuse('expansion', i);
    } else if (POSIX_OPERATORS.includes(c)) {
      refuse('shell_operator', i);
    } else if (POSIX_GLOBS.includes(c)) {
      refuse('glob', i);
    } else if (wordStart && c === '~') {
      refuse('expansion', i);
    } else if (wordStart && c === '#') {
      refuse('shell_operator', i);
    } else {
      current += c;
    }
  }
  if (inWord) words.push(current);
  return words;
}

// ---------------------------------------------------------------- MSVCRT

/** The child's command-line parse (MSVCRT 2008+ / `CommandLineToArgvW` arguments). */
function parseMsvcrt(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (isBlank(line[i])) i += 1;
    if (i >= line.length) break;
    let arg = '';
    let inQuotes = false;
    while (i < line.length) {
      const c = line[i]!;
      if (!inQuotes && isBlank(c)) break;
      if (c === '\\') {
        let k = 0;
        while (line[i + k] === '\\') k += 1;
        if (line[i + k] === '"') {
          arg += '\\'.repeat(Math.floor(k / 2));
          if (k % 2 === 1) {
            arg += '"';
            i += k + 1;
          } else {
            i += k;
          }
        } else {
          arg += '\\'.repeat(k);
          i += k;
        }
        continue;
      }
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          arg += '"';
          i += 2;
          continue;
        }
        inQuotes = !inQuotes;
        i += 1;
        continue;
      }
      arg += c;
      i += 1;
    }
    args.push(arg);
  }
  return args;
}

// ---------------------------------------------------------------- PowerShell 5.1

const PS_OPERATORS = '|;&<>(){},';

/** PowerShell's argument-mode values, before native passing. */
function powerShellValues(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inWord = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (isBlank(c)) {
      if (inWord) values.push(current);
      current = '';
      inWord = false;
      continue;
    }
    const wordStart = !inWord;
    inWord = true;
    if (c === "'") {
      const open = i;
      i += 1;
      for (;;) {
        if (i >= line.length) refuse('unterminated_quote', open);
        if (line[i] === "'") {
          if (line[i + 1] === "'") {
            current += "'";
            i += 2;
            continue;
          }
          break;
        }
        current += line[i];
        i += 1;
      }
    } else if (c === '"') {
      const open = i;
      i += 1;
      for (;;) {
        if (i >= line.length) refuse('unterminated_quote', open);
        const d = line[i]!;
        if (d === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i += 2;
            continue;
          }
          break;
        }
        if (d === '`') {
          if (i + 1 >= line.length) refuse('unterminated_quote', open);
          current += line[i + 1];
          i += 2;
          continue;
        }
        if (d === '$') refuse('expansion', i);
        current += d;
        i += 1;
      }
    } else if (c === '`') {
      if (i + 1 < line.length) {
        current += line[i + 1];
        i += 1;
      }
    } else if (c === '$' || (c === '@' && line[i + 1] === '(')) {
      refuse('expansion', i);
    } else if (PS_OPERATORS.includes(c)) {
      refuse('shell_operator', i);
    } else if (wordStart && c === '#') {
      refuse('shell_operator', i);
    } else {
      current += c;
    }
  }
  if (inWord) values.push(current);
  return values;
}

/** PowerShell 5.1's legacy rule for wrapping a native argument in double quotes. */
function needsNativeQuotes(value: string): boolean {
  let followingBackslash = false;
  let quotes = 0;
  for (const c of value) {
    if (c === '"' && !followingBackslash) quotes += 1;
    else if (/\s/u.test(c) && quotes % 2 === 0) return true;
    followingBackslash = c === '\\';
  }
  return false;
}

function tokenizePowerShell(line: string): string[] {
  const native = powerShellValues(line)
    .filter((value) => value !== '') // 5.1 drops an empty string argument
    .map((value) => (needsNativeQuotes(value) ? `"${value}"` : value))
    .join(' ');
  return parseMsvcrt(native);
}

// ---------------------------------------------------------------- cmd

const CMD_PERCENT_VAR = /%[^%\s]+%/u;
const CMD_DELAYED_VAR = /![A-Za-z_][A-Za-z0-9_]*!/u;

function tokenizeCmd(line: string): string[] {
  const percent = CMD_PERCENT_VAR.exec(line);
  if (percent !== null) refuse('expansion', percent.index);
  const delayed = CMD_DELAYED_VAR.exec(line);
  if (delayed !== null) refuse('expansion', delayed.index);
  let passed = '';
  let inQuotes = false;
  let open = -1;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (c === '"') {
      inQuotes = !inQuotes;
      open = inQuotes ? i : -1;
    }
    if (!inQuotes && c === '^') {
      i += 1;
      passed += line[i] ?? '';
      continue;
    }
    if (!inQuotes && '&|<>'.includes(c)) refuse('shell_operator', i);
    passed += c;
  }
  if (inQuotes) refuse('unterminated_quote', open);
  return parseMsvcrt(passed);
}

// ---------------------------------------------------------------- entry

const TOKENIZERS: Readonly<Record<Shell, (line: string) => string[]>> = {
  posix: tokenizePosix,
  powershell: tokenizePowerShell,
  cmd: tokenizeCmd,
};

/**
 * Tokenizes `text` as `shell` would hand it to the program, dropping one
 * leading `yantra`. Trailing line breaks (a pasted line) are ignored; any
 * other line break refuses the whole line. Never throws.
 */
export function tokenizeCommandLine(text: string, shell: Shell): TokenizeResult {
  const line = text.replace(/[\r\n]+$/u, '');
  const lineBreak = line.search(/[\r\n]/u);
  if (lineBreak !== -1) return { ok: false, reason: 'multiline', at: lineBreak };
  if (line.trim() === '') return { ok: false, reason: 'empty', at: 0 };
  try {
    const tokens = TOKENIZERS[shell](line);
    const argv = tokens[0] === 'yantra' ? tokens.slice(1) : tokens;
    if (argv.length === 0) return { ok: false, reason: 'empty', at: 0 };
    return { ok: true, argv };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason, at: error.at };
    throw error;
  }
}
