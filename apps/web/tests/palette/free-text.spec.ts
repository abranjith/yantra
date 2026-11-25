import { COMMAND_REGISTRY, type Shell } from '@yantra/protocol/commands';
import { describe, expect, it } from 'vitest';

import { freeTextOf, readCommand } from '../../src/palette/palette-model.js';
import {
  commandText,
  explainParse,
  nothingToRun,
  paletteSections,
  type PaletteSection,
} from '../../src/palette/suggestions.js';
import { PARITY_MANIFEST } from '../../src/parity/manifest.js';

function read(query: string, shell: Shell) {
  return readCommand(commandText(query) ?? '', shell, COMMAND_REGISTRY, PARITY_MANIFEST);
}

function sectionsFor(query: string, shell: Shell = 'powershell'): PaletteSection[] {
  const command = commandText(query);
  const reading = command === null ? null : read(query, shell);
  return paletteSections(query, {
    command,
    outcome: reading?.outcome ?? null,
    armed: false,
    ...(reading === null ? {} : { line: reading.line, quoted: reading.quoted }),
  });
}

describe('@no-llm a question typed after ask, research or do', () => {
  it.each(['powershell', 'posix'] as const)(
    'runs "yantra ask summarize today\'s stock market" as one question (%s)',
    (shell) => {
      const reading = read("yantra ask summarize today's stock market", shell);

      expect(reading.quoted).toBe(true);
      expect(reading.outcome).toMatchObject({
        state: 'ready',
        command: 'ask',
        invocation: { path: ['ask'], argv: ["summarize today's stock market"] },
      });
    },
  );

  it.each([
    ['yantra ask summarize the stock market', 'summarize the stock market'],
    ['yantra research what is the price of gold?', 'what is the price of gold?'],
    ['yantra do buy 2 tickets under $50', 'buy 2 tickets under $50'],
    ['yantra ask "what\'s new', "what's new"],
  ])('reads %s as one free-text argument', (query, text) => {
    for (const shell of ['powershell', 'posix'] as const) {
      expect(read(query, shell).outcome).toMatchObject({
        state: 'ready',
        invocation: { argv: [text] },
      });
    }
  });

  it('leaves a line with options to the person', () => {
    expect(freeTextOf('ask summarize --depth 3 market')).toBeNull();
    expect(read('yantra ask summarize the --no-llm market', 'posix').quoted).toBe(false);
  });

  it('runs a well-quoted line as typed', () => {
    const reading = read('yantra ask "summarize the stock market"', 'posix');
    expect(reading.quoted).toBe(false);
    expect(reading.line).toBe('yantra ask "summarize the stock market"');
  });

  it('says the quoted run in plain words, and offers to open Mission first', () => {
    const [command] = sectionsFor("yantra ask summarize today's stock market");

    expect(command?.items[0]).toMatchObject({
      label: "Ask “summarize today's stock market”",
      description: 'Starts a run and opens it.',
      isDisabled: false,
      target: { kind: 'run' },
    });
    expect(command?.items[1]).toMatchObject({
      label: 'Open in Mission first',
      target: { kind: 'start', mode: 'ask', goal: "summarize today's stock market" },
    });
  });

  it('keeps the command line as typed when it needed no help', () => {
    const [command] = sectionsFor('yantra ask "summarize the stock market"', 'posix');
    expect(command?.items[0]?.label).toBe('yantra ask "summarize the stock market"');
  });
});

describe('@no-llm a line that cannot run says why', () => {
  it('explains an unclosed quote in a command that takes no free text', () => {
    const sections = sectionsFor("yantra sites add 'example.com");

    expect(nothingToRun(sections)).toBe(
      'A quote is opened and never closed. Close it, or take it out.',
    );
  });

  it('explains too many words with the whole command name', () => {
    expect(
      explainParse(
        ["error: too many arguments for 'add'. Expected 1 argument but got 2."],
        'sites add',
      ),
    ).toBe(
      'Too many words for yantra sites add: it takes 1 argument. Put text with spaces in quotes.',
    );
  });

  it('has nothing to explain when something can run', () => {
    expect(nothingToRun(sectionsFor('yantra doctor'))).toBeNull();
  });
});
