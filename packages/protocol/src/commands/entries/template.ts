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
