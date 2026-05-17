import picocolors from 'picocolors';

import type { AskCard } from './types.js';

export type { AskCard } from './types.js';

export interface RenderTerminalOptions {
  readonly color?: boolean;
  readonly width?: number;
}

/**
 * Renders ask cards as plain terminal boxes.
 */
export function renderTerminal(
  cards: readonly AskCard[],
  options: RenderTerminalOptions = {},
): string {
  const width = Math.max(40, options.width ?? 80);
  const useColor = options.color ?? false;
  const color = useColor ? picocolors : noColor;

  return cards
    .map((card) => {
      const bodyWidth = width - 4;
      const lines: string[] = [];
      lines.push(color.bold(card.title));
      lines.push(color.dim(`${card.source} • fetched ${card.fetchedAt}`));
      if (card.publishedAt) {
        lines.push(color.dim(`published ${card.publishedAt}`));
      }
      lines.push('');
      lines.push(...wrap(card.summary, bodyWidth));
      lines.push('');
      lines.push(...wrap(`> ${card.quotedSnippet}`, bodyWidth));
      if (card.notice) {
        lines.push('');
        lines.push(color.yellow(card.notice));
      }
      lines.push('');
      lines.push(color.dim(card.url));
      return box(lines, width);
    })
    .join('\n\n');
}

/**
 * Renders ask cards as stable JSON payload.
 */
export function renderJson(cards: readonly AskCard[]): { cards: readonly AskCard[] } {
  return { cards };
}

/**
 * Renders ask cards as markdown report sections.
 */
export function renderMarkdown(cards: readonly AskCard[]): string {
  const lines: string[] = ['# Ask Report', ''];

  cards.forEach((card, index) => {
    lines.push(`## ${index + 1}. ${card.title}`);
    lines.push('');
    lines.push(`- Source: ${card.source}`);
    lines.push(`- URL: ${card.url}`);
    lines.push(`- Fetched: ${card.fetchedAt}`);
    lines.push(`- Published: ${card.publishedAt ?? 'n/a'}`);
    lines.push(`- Summary kind: ${card.summaryKind}`);
    lines.push('');
    lines.push(card.summary);
    lines.push('');
    lines.push(`> ${card.quotedSnippet}`);
    if (card.notice) {
      lines.push('');
      lines.push(`**Notice:** ${card.notice}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

const noColor = {
  bold: (value: string): string => value,
  dim: (value: string): string => value,
  yellow: (value: string): string => value,
};

function box(contentLines: readonly string[], width: number): string {
  const top = `+${'-'.repeat(width - 2)}+`;
  const body = contentLines
    .map((line) => {
      const stripped = stripAnsi(line);
      const pad = Math.max(0, width - 4 - stripped.length);
      return `| ${line}${' '.repeat(pad)} |`;
    })
    .join('\n');
  return `${top}\n${body}\n${top}`;
}

function stripAnsi(value: string): string {
  let output = '';
  let index = 0;

  while (index < value.length) {
    const char = value.charCodeAt(index);
    if (char === 27 && value[index + 1] === '[') {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    output += value[index] ?? '';
    index += 1;
  }

  return output;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return [''];
  }

  const lines: string[] = [];
  let current = words[0] ?? '';

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? '';
    const candidate = `${current} ${word}`;
    if (candidate.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  lines.push(current);
  return lines;
}
