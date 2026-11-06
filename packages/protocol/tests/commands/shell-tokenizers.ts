/**
 * Reference tokenizers used only by the format round-trip tests. Each turns a
 * formatted command line into the argv the program would receive:
 *
 * - POSIX: shell word splitting with single quotes, double quotes and
 *   backslash escapes (no expansions; a stray metacharacter is an error);
 * - PowerShell 5.1: PowerShell's tokenizer for bare and quoted arguments, then
 *   its legacy native-argument passing, then the child's MSVCRT parse;
 * - cmd: cmd's caret and metacharacter handling, then the MSVCRT parse.
 *
 * They are deliberately independent of `format.ts`: they model the shells,
 * not the formatter.
 */

export class TokenizeError extends Error {}

// ---------------------------------------------------------------- POSIX

export function tokenizePosix(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (c === ' ' || c === '\t') {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new TokenizeError('unterminated single quote');
      current += line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && '$`"\\\n'.includes(line[i + 1] ?? '')) {
          if (line[i + 1] !== '\n') current += line[i + 1];
          i += 2;
          continue;
        }
        if (line[i] === '$' || line[i] === '`')
          throw new TokenizeError('expansion in double quotes');
        current += line[i];
        i += 1;
      }
      if (i >= line.length) throw new TokenizeError('unterminated double quote');
    } else if (c === '\\') {
      if (i + 1 >= line.length) throw new TokenizeError('trailing backslash');
      if (line[i + 1] !== '\n') current += line[i + 1];
      i += 1;
    } else if ('|&;<>()$`*?[#~{}!\n'.includes(c) && !(c === '#' && current.length > 0)) {
      throw new TokenizeError(`unquoted shell metacharacter ${JSON.stringify(c)}`);
    } else {
      current += c;
    }
  }
  if (inWord) words.push(current);
  return words;
}

// ---------------------------------------------------------------- MSVCRT

/** The child's command-line parse (MSVCRT 2008+, `CommandLineToArgvW` for arguments). */
export function parseMsvcrt(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i += 1;
    if (i >= line.length) break;
    let arg = '';
    let inQuotes = false;
    while (i < line.length) {
      const c = line[i]!;
      if (!inQuotes && (c === ' ' || c === '\t')) break;
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

const PS_BARE_FORBIDDEN = /[\s'"`$,;(){}|&<>@#]/;

/** PowerShell's own tokenizer, for the argument forms a command line uses. */
export function tokenizePowerShellValues(line: string): string[] {
  const values: string[] = [];
  let i = 0;
  let first = true;
  while (i < line.length) {
    while (line[i] === ' ') i += 1;
    if (i >= line.length) break;
    if (first && line[i] === '&' && line[i + 1] === ' ') {
      i += 2;
      first = false;
      continue;
    }
    first = false;
    if (line[i] === "'") {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= line.length) throw new TokenizeError('unterminated single quote');
        if (line[i] === "'") {
          if (line[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += line[i];
        i += 1;
      }
      if (i < line.length && line[i] !== ' ')
        throw new TokenizeError('text after a quoted argument');
      values.push(value);
      continue;
    }
    let end = i;
    while (end < line.length && line[end] !== ' ') end += 1;
    const word = line.slice(i, end);
    if (PS_BARE_FORBIDDEN.test(word) || word === '--') {
      throw new TokenizeError(`bare word PowerShell would reinterpret: ${JSON.stringify(word)}`);
    }
    values.push(word);
    i = end;
  }
  return values;
}

/** PowerShell 5.1's legacy decision to wrap a native argument in quotes. */
function needsQuotes(value: string): boolean {
  let followingBackslash = false;
  let quotes = 0;
  for (const c of value) {
    if (c === '"' && !followingBackslash) quotes += 1;
    else if (/\s/.test(c) && quotes % 2 === 0) return true;
    followingBackslash = c === '\\';
  }
  return false;
}

/** The native command line PowerShell 5.1 builds from argument values. */
export function powerShellNativeLine(values: readonly string[]): string {
  return values
    .filter((value) => value !== '') // 5.1 drops an empty string argument
    .map((value) => (needsQuotes(value) ? `"${value}"` : value))
    .join(' ');
}

/** PowerShell 5.1 → native: the argv a native program receives. */
export function tokenizePowerShell(line: string): string[] {
  return parseMsvcrt(powerShellNativeLine(tokenizePowerShellValues(line)));
}

// ---------------------------------------------------------------- cmd

/**
 * cmd hands the rest of the line to the program after its own pass: outside
 * quotes `^` escapes the next character and `&|<>` would split or redirect
 * the command; `%` expands anywhere.
 */
export function tokenizeCmd(line: string): string[] {
  let passed = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (c === '%') throw new TokenizeError('percent sign would expand');
    if (/[\r\n]/.test(c)) throw new TokenizeError('line break ends the command');
    if (c === '"') inQuotes = !inQuotes;
    if (!inQuotes && c === '^') {
      i += 1;
      passed += line[i] ?? '';
      continue;
    }
    if (!inQuotes && '&|<>'.includes(c)) throw new TokenizeError(`unquoted ${c}`);
    passed += c;
  }
  return parseMsvcrt(passed);
}

export type ShellName = 'posix' | 'powershell' | 'cmd';

export const TOKENIZERS: Readonly<Record<ShellName, (line: string) => string[]>> = {
  posix: tokenizePosix,
  powershell: tokenizePowerShell,
  cmd: tokenizeCmd,
};
