import { findLeaf } from '@yantra/protocol/commands';
import { Button, Dialog, DialogTrigger, Tooltip, TooltipTrigger } from '@yantra/ui';
import { useId, type ReactNode } from 'react';

import { ConfigEditAdapter } from '../adapters/ConfigEditAdapter.js';
import { DaemonAdapter } from '../adapters/DaemonAdapter.js';
import { PageHeader } from '../app/shell/PageHeader.js';
import { commandTemplate } from '../generated/command-template.js';
import { GeneratedForm } from '../generated/GeneratedForm.js';
import { GeneratedRecord } from '../generated/GeneratedRecord.js';
import { GeneratedTable } from '../generated/GeneratedTable.js';

import {
  schemaFor,
  type SurfaceAction,
  type SurfaceDefinition,
  type SurfaceRead,
} from './definitions.js';
import { InstallationResetTrigger } from './onboarding/installation-reset-dialog.js';

/** One read: its title, the command it runs, then its table or record. */
function ReadSection({
  read,
  cwd,
}: {
  readonly read: SurfaceRead;
  readonly cwd: string;
}): ReactNode {
  const headingId = useId();
  const schema = schemaFor(read);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <h2 id={headingId} className="type-section text-ink">
          {read.title}
        </h2>
        <span className="type-engine text-caption text-ink-3">yantra {read.command}</span>
      </div>
      {read.view === 'record' ? (
        <GeneratedRecord read={read} schema={schema} />
      ) : (
        <GeneratedTable read={read} schema={schema} cwd={cwd} />
      )}
    </section>
  );
}

/**
 * A page action: a plain-word button that opens the command's form. Hovering
 * or focusing it shows the exact command it runs (rule 4 of Interface Study
 * 01: every action has a CLI twin).
 */
function ActionButton({
  action,
  cwd,
  defaultOpen,
}: {
  readonly action: SurfaceAction;
  readonly cwd: string;
  readonly defaultOpen: boolean;
}): ReactNode {
  const command = findLeaf(action.command.split(' '));
  if (command === undefined) return null;
  return (
    <DialogTrigger defaultOpen={defaultOpen}>
      <TooltipTrigger>
        <Button variant={action.primary === true ? 'primary' : 'secondary'}>{action.label}</Button>
        <Tooltip className="max-w-96 type-engine">{commandTemplate(command)}</Tooltip>
      </TooltipTrigger>
      <Dialog title={action.label}>
        <GeneratedForm command={command} cwd={cwd} />
      </Dialog>
    </DialogTrigger>
  );
}

/**
 * A page generated from the command registry and its `--json` schemas
 * (FEAT-070), in the shared page template: the header with the page's
 * actions, then one section per read.
 */
export function GeneratedSurface({
  definition,
  cwd = '/',
  initialMode,
  intent,
  focus,
  openAction,
}: {
  readonly definition: SurfaceDefinition;
  readonly cwd?: string;
  readonly initialMode?: 'raw' | undefined;
  readonly intent?: 'install' | undefined;
  readonly focus?: string | undefined;
  /** The page action whose form opens at once (`?do=`, from the command palette). */
  readonly openAction?: string | undefined;
}): ReactNode {
  const installation = definition.id === 'installation';
  const actions = [
    ...definition.actions.map((action) => (
      <ActionButton
        key={action.command}
        action={action}
        cwd={cwd}
        defaultOpen={
          action.command === openAction ||
          (intent === 'install' && action.command === 'browser install')
        }
      />
    )),
    ...(installation
      ? [
          <ConfigEditAdapter key="config-edit" cwd={cwd} defaultOpen={initialMode === 'raw'} />,
          <InstallationResetTrigger key="setup-again" />,
        ]
      : []),
    ...(definition.id === 'daemon' ? [<DaemonAdapter key="daemon" cwd={cwd} />] : []),
  ];
  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title={definition.title}
        path={definition.route}
        {...(definition.description === undefined ? {} : { description: definition.description })}
        {...(actions.length === 0 ? {} : { actions })}
      />
      {definition.notes === undefined && focus === undefined ? null : (
        <div className="-mt-4 flex flex-col gap-2">
          {definition.notes?.map((note) => (
            <p key={note} className="text-ink-2">
              {note}
            </p>
          ))}
          {focus === undefined ? null : (
            <p className="rounded-frame border border-rule bg-surface px-3 py-2 text-micro text-ink-2">
              Focused setting: <span className="type-engine text-ink">{focus}</span>
            </p>
          )}
        </div>
      )}
      {definition.reads.map((read) => (
        <ReadSection key={`${read.method}:${read.args?.join(' ') ?? ''}`} read={read} cwd={cwd} />
      ))}
    </div>
  );
}
