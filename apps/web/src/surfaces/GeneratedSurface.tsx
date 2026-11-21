import { findLeaf } from '@yantra/protocol/commands';
import { Button, Dialog, DialogTrigger } from '@yantra/ui';
import type { ReactNode } from 'react';

import { ConfigEditAdapter } from '../adapters/ConfigEditAdapter.js';
import { DaemonAdapter } from '../adapters/DaemonAdapter.js';
import { GeneratedForm } from '../generated/GeneratedForm.js';
import { GeneratedTable } from '../generated/GeneratedTable.js';

import { schemaFor, type SurfaceDefinition } from './definitions.js';
import { InstallationResetTrigger } from './onboarding/installation-reset-dialog.js';

export function GeneratedSurface({
  definition,
  cwd = '/',
  initialMode,
  intent,
  focus,
}: {
  readonly definition: SurfaceDefinition;
  readonly cwd?: string;
  readonly initialMode?: 'raw' | undefined;
  readonly intent?: 'install' | undefined;
  readonly focus?: string | undefined;
}): ReactNode {
  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-display font-semibold">{definition.title}</h1>
      </header>
      {definition.notes?.map((note) => (
        <p key={note} className="text-ink-2">
          {note}
        </p>
      ))}
      {focus !== undefined ? (
        <p className="rounded-card border border-rule bg-surface px-3 py-2 text-xs text-ink-2">
          Focused setting: <span className="type-engine text-ink">{focus}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {definition.actions.map((path) => {
          const command = findLeaf(path.split(' '));
          if (command === undefined) return null;
          const openByIntent = intent === 'install' && path === 'browser install';
          return (
            <DialogTrigger key={path} defaultOpen={openByIntent}>
              <Button>{command.path.join(' ')}</Button>
              <Dialog title={command.path.join(' ')}>
                <GeneratedForm command={command} cwd={cwd} />
              </Dialog>
            </DialogTrigger>
          );
        })}
        {definition.id === 'installation' ? <InstallationResetTrigger /> : null}
      </div>
      {definition.id === 'installation' ? (
        <ConfigEditAdapter cwd={cwd} defaultOpen={initialMode === 'raw'} />
      ) : null}
      {definition.id === 'daemon' ? <DaemonAdapter cwd={cwd} /> : null}
      {definition.reads.map((read) => (
        <GeneratedTable
          key={`${read.method}:${read.args?.join(' ') ?? ''}`}
          method={read.method}
          schema={schemaFor(read)}
          {...(read.args === undefined ? {} : { args: read.args })}
          title={read.command}
          rowActions={definition.rowActions}
          cwd={cwd}
        />
      ))}
    </section>
  );
}
