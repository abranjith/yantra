/** Report template library: `template new|lint|save|list|show|remove`. */

import { argument, exit, group, jsonOption, leaf, option, PARSE_ERRORS } from './builders.js';

const NO_DANGER = { level: 'none' } as const;
const TEMPLATE_JSON = { flag: '--json', shape: 'envelope', schema: null } as const;
const templateRef = { kind: 'template-ref' } as const;
const envelope = () => jsonOption('emit a stable JSON envelope');

export const template = group({
  id: 'template',
  description: 'Create, validate, save, inspect, and remove report templates.',
  registration: 'added',
});

const confirm = (reason: string) => ({ level: 'confirm', reason }) as const;
const forceOption = (reason: string) =>
  option('--force', 'overwrite an existing template', { default: false, danger: confirm(reason) });
const TEMPLATE_EXITS = [
  exit.ok(),
  exit.validation(`${PARSE_ERRORS}, an invalid or unknown name, or a template that fails to parse`),
] as const;

export const templateNew = leaf({
  id: 'template.new',
  description: 'Create a starter template covering every slot kind.',
  registration: 'subcommand',
  arguments: [argument('name', { description: 'saved template name', required: true })],
  options: [
    option('--tags <a,b>', 'comma-separated tags'),
    forceOption('overwrites the saved template with the same name'),
    envelope(),
  ],
  execution: { default: 'mutate' },
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [...TEMPLATE_EXITS],
  json: TEMPLATE_JSON,
});

export const templateLint = leaf({
  id: 'template.lint',
  description: 'Parse a saved template or Markdown path and print its slot manifest.',
  registration: 'subcommand',
  arguments: [
    argument('name-or-path', {
      description: 'saved name or Markdown file path',
      required: true,
      input: templateRef,
    }),
  ],
  options: [envelope()],
  execution: { default: 'mutate' },
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [...TEMPLATE_EXITS],
  json: TEMPLATE_JSON,
});

export const templateSave = leaf({
  id: 'template.save',
  description: 'Validate and save a Markdown template in the local library.',
  registration: 'subcommand',
  arguments: [
    argument('path', {
      description: 'template Markdown path',
      required: true,
      input: { kind: 'path', target: 'file' },
    }),
  ],
  options: [
    option('--name <name>', 'saved name (defaults to frontmatter or filename)'),
    option('--tags <a,b>', 'replace frontmatter tags'),
    option('--description <text>', 'replace the frontmatter description'),
    forceOption('overwrites the saved template with the same name'),
    envelope(),
  ],
  execution: { default: 'mutate' },
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [...TEMPLATE_EXITS],
  json: TEMPLATE_JSON,
});

export const templateList = leaf({
  id: 'template.list',
  description: 'List valid saved report templates.',
  registration: 'subcommand',
  options: [option('--tag <tag>', 'show only templates carrying this tag'), envelope()],
  execution: { default: 'read' },
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [exit.ok(), exit.validation(PARSE_ERRORS)],
  json: TEMPLATE_JSON,
});

export const templateShow = leaf({
  id: 'template.show',
  description: 'Print a saved template and its parsed slots.',
  registration: 'subcommand',
  arguments: [
    argument('name', { description: 'saved template name', required: true, input: templateRef }),
  ],
  options: [envelope()],
  execution: { default: 'read' },
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(
      `${PARSE_ERRORS}, an invalid or unknown name, or a template that fails to parse`,
    ),
  ],
  json: TEMPLATE_JSON,
});

export const templateRemove = leaf({
  id: 'template.remove',
  description: 'Delete a saved report template.',
  registration: 'subcommand',
  arguments: [
    argument('name', { description: 'saved template name', required: true, input: templateRef }),
  ],
  options: [envelope()],
  execution: { default: 'mutate' },
  effect: 'local',
  danger: confirm('deletes the saved report template'),
  exit_codes: [...TEMPLATE_EXITS],
  json: TEMPLATE_JSON,
});
