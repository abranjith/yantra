/**
 * The cockpit's frame (FEAT-067 TASK-002): four glass panels over a backdrop
 * slot.
 *
 * - Panels: the top bar, **Understood** (what the run is for), **Engine**
 *   (what it is doing) and **Command** (the CLI twin and recovery).
 * - Drshya rule: glass for the frame and controls, paper for content. Where
 *   text runs, it sits on a solid surface inside the glass panel, so it never
 *   depends on what shows through.
 * - The backdrop is neutral until FEAT-069 puts the live browser view there;
 *   it is decorative and hidden from assistive technology.
 */

import type { ReactNode } from 'react';

export interface CockpitLayoutProps {
  readonly topBar: ReactNode;
  /** The displayed-state banner (TASK-005), under the top bar. */
  readonly status?: ReactNode;
  readonly understood: ReactNode;
  readonly engine: ReactNode;
  readonly command: ReactNode;
  /** Decorative; FEAT-069 renders the live browser view here. */
  readonly backdrop?: ReactNode;
  /** The polite live region (TASK-006). */
  readonly announcer?: ReactNode;
  /** `solid` once the live view went over budget (FEAT-069): a runtime override. */
  readonly surfaces?: 'solid';
}

function Panel({
  id,
  title,
  className,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section
      aria-labelledby={`cockpit-${id}`}
      data-panel={id}
      className={`glass flex min-w-0 flex-col gap-2 rounded-frame p-3 ${className ?? ''}`}
    >
      <h2 id={`cockpit-${id}`} className="type-label px-1 text-ink-2">
        {title}
      </h2>
      <div className="flex min-w-0 flex-col gap-3 rounded-control bg-surface p-3">{children}</div>
    </section>
  );
}

/** See the module comment. */
export function CockpitLayout({
  topBar,
  status,
  understood,
  engine,
  command,
  backdrop,
  announcer,
  surfaces,
}: CockpitLayoutProps): ReactNode {
  return (
    <div
      data-part="cockpit"
      {...(surfaces === undefined ? {} : { 'data-surfaces': surfaces })}
      className="relative isolate overflow-hidden rounded-frame bg-sunken"
    >
      <div aria-hidden="true" data-slot="backdrop" className="absolute inset-0 -z-10">
        {backdrop}
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div data-panel="top-bar" className="glass rounded-frame p-3">
          <div className="rounded-control bg-surface p-2">{topBar}</div>
        </div>
        {status}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Panel id="understood" title="Understood">
            {understood}
          </Panel>
          <Panel id="engine" title="Engine">
            {engine}
          </Panel>
        </div>
        <Panel id="command" title="Command">
          {command}
        </Panel>
      </div>
      {announcer}
    </div>
  );
}
