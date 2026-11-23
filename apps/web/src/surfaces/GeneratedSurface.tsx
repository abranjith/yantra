import { findLeaf } from '@yantra/protocol/commands';
import { Button, Dialog, DialogTrigger } from '@yantra/ui';
import { useId, type ReactNode } from 'react';

import { ConfigEditAdapter } from '../adapters/ConfigEditAdapter.js';
import { DaemonAdapter } from '../adapters/DaemonAdapter.js';
import { GeneratedForm } from '../generated/GeneratedForm.js';
import { GeneratedRecord } from '../generated/GeneratedRecord.js';
import { GeneratedTable } from '../generated/GeneratedTable.js';

import { schemaFor, type SurfaceDefinition, type SurfaceRead } from './definitions.js';
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
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-lead font-semibold text-ink">
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
        <h1 className="text-title font-semibold text-ink">{definition.title}</h1>
      </header>
      {definition.notes?.map((note) => (
        <p key={note} className="text-ink-2">
          {note}
        </p>
      ))}
      {focus !== undefined ? (
        <p className="rounded-frame border border-rule bg-surface px-3 py-2 text-micro text-ink-2">
          Focused setting: <span className="type-engine text-ink">{focus}</span>
        </p>
      ) : null}
      {definition.actions.length === 0 && definition.id !== 'installation' ? null : (
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
          {definition.id === 'installation' ? (
            <ConfigEditAdapter cwd={cwd} defaultOpen={initialMode === 'raw'} />
          ) : null}
          {definition.id === 'installation' ? <InstallationResetTrigger /> : null}
        </div>
      )}
      {definition.id === 'daemon' ? <DaemonAdapter cwd={cwd} /> : null}
      {definition.reads.map((read) => (
        <ReadSection key={`${read.method}:${read.args?.join(' ') ?? ''}`} read={read} cwd={cwd} />
      ))}
    </section>
  );
}
