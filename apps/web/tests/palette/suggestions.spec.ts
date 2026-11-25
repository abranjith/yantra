import { COMMAND_REGISTRY } from '@yantra/protocol/commands';
import { describe, expect, it } from 'vitest';

import { interpret } from '../../src/palette/palette-model.js';
import {
  commandText,
  matchScore,
  paletteSections,
  type PaletteSection,
} from '../../src/palette/suggestions.js';
import { PARITY_MANIFEST } from '../../src/parity/manifest.js';
import { actionSearch } from '../../src/routes/generated.js';

/** The palette's sections for `query`, interpreting it as the component does. */
function sectionsFor(query: string, armed = false): PaletteSection[] {
  const command = commandText(query);
  const outcome =
    command === null ? null : interpret(command, 'posix', COMMAND_REGISTRY, PARITY_MANIFEST);
  return paletteSections(query, { command, outcome, armed });
}

function labels(sections: readonly PaletteSection[], id: string): string[] {
  return sections.find((section) => section.id === id)?.items.map((item) => item.label) ?? [];
}

describe('@no-llm command palette suggestions', () => {
  it('shows how to start and where to go before anything is typed', () => {
    const sections = sectionsFor('');

    expect(sections.map((section) => section.title)).toEqual(['Start', 'Go to']);
    expect(labels(sections, 'start')).toEqual([
      'Ask a question',
      'Research a topic',
      'Do a task on a website',
      'Run a saved workflow',
    ]);
    expect(labels(sections, 'go')).toContain('Ledger');
  });

  it('finds pages by name and by the words people use for them', () => {
    const models = sectionsFor('models');
    expect(labels(models, 'go')[0]).toBe('Models');
    expect(models.find((s) => s.id === 'go')?.items[0]?.hint).toBe('Settings · Setup');
    expect(labels(models, 'actions')).toContain('Add a model');

    expect(labels(sectionsFor('api key'), 'go')).toContain('Credentials');
    expect(labels(sectionsFor('doctor'), 'go')).toContain('Health');
  });

  it('offers to start with what was typed, first when it reads as a goal', () => {
    const sections = sectionsFor('cheap flights to Lisbon in March');

    expect(sections[0]?.title).toBe('Start with this');
    expect(labels(sections, 'start')).toEqual([
      'Ask “cheap flights to Lisbon in March”',
      'Research “cheap flights to Lisbon in March”',
      'Do “cheap flights to Lisbon in March”',
    ]);
  });

  it('suggests commands for a command word and fills the line when chosen', () => {
    const sites = sectionsFor('sites').find((section) => section.id === 'commands');

    expect(sites?.items.map((item) => item.label)).toContain('yantra sites add <domain>');
    expect(sites?.items.find((item) => item.label === 'yantra sites add <domain>')?.target).toEqual(
      {
        kind: 'fill',
        text: 'yantra sites add ',
      },
    );
  });

  it('tells which text is a command', () => {
    expect(commandText('yantra doctor')).toBe('doctor');
    expect(commandText('doctor')).toBe('doctor');
    expect(commandText('sites add example.com')).toBe('sites add example.com');
    expect(commandText('sites')).toBeNull();
    expect(commandText('find cheap flights')).toBeNull();
  });

  it('says what a ready command will do, first', () => {
    const [first] = sectionsFor('yantra sites add example.com');

    expect(first?.title).toBe('Command');
    expect(first?.items[0]).toMatchObject({
      label: 'yantra sites add example.com',
      isDisabled: false,
      target: { kind: 'run' },
    });
  });

  it('says what an unfinished command still needs, and offers its template', () => {
    const [first] = sectionsFor('yantra sites add');

    expect(first?.items[0]?.isDisabled).toBe(true);
    expect(first?.items[0]?.description).toBe('Still needs <domain>. Type it after the command.');
    expect(first?.items[1]?.label).toBe('yantra sites add <domain>');
    expect(sectionsFor('yantra schedule nightly')[0]?.items[0]?.description).toBe(
      'Still needs --cron. Type it after the command.',
    );
  });

  it('asks for a second Enter before a dangerous command', () => {
    expect(sectionsFor('unschedule s-1')[0]?.items[0]?.description).toMatch(/confirm first/u);
    expect(sectionsFor('unschedule s-1', true)[0]?.items[0]?.label).toBe(
      'Confirm: yantra unschedule s-1',
    );
  });

  it('opens every page action’s form through a link its page accepts', () => {
    const actions = sectionsFor('a').flatMap((section) =>
      section.id === 'actions' ? section.items : [],
    );
    const all = [
      ...actions,
      ...['value', 'model', 'site', 'template', 'browser', 'schedule', 'workflow'].flatMap(
        (query) => sectionsFor(query).find((section) => section.id === 'actions')?.items ?? [],
      ),
    ];
    for (const item of all) {
      if (item.target.kind !== 'go' || !item.target.path.includes('?do=')) continue;
      const action = new URL(item.target.path, 'http://app').searchParams.get('do');
      expect(actionSearch({ do: action })).toEqual({ do: action });
    }
    expect(all.length).toBeGreaterThan(5);
  });

  it('scores label matches above description matches', () => {
    expect(matchScore('mod', 'Models')).toBeGreaterThan(matchScore('mod', 'Health', 'model'));
    expect(matchScore('xyz', 'Models')).toBe(0);
  });
});
