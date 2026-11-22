/**
 * The cockpit's frame (FEAT-067 TASK-002): four glass panels floating over
 * the live browser, which fills the frame (FEAT-069; the Mission concept in
 * `ui_brainstorm.md`, review REV-003).
 *
 * - The frame has a fixed height. The backdrop (the live browser view) fills
 *   all of it; the panels sit at its edges: the top bar and the status banner
 *   across the top, **Understood** and **Engine** as side rails, **Command**
 *   along the bottom. The centre is left clear (`data-slot="viewport-window"`)
 *   so the page the run is acting on stays visible. Rails scroll on their own.
 * - Below the `lg` breakpoint there is no room for rails beside the page, so
 *   the browser view is an in-flow, fixed-height viewport under the top bar
 *   and the panels stack under it.
 * - Drshya rule: glass for the frame and controls, paper for content. Where
 *   text runs, it sits on a solid surface inside the glass panel, so it never
 *   depends on what shows through.
 * - The backdrop is decorative and hidden from assistive technology; the
 *   Engine panel carries its text alternative.
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
      className={`glass flex min-h-0 min-w-0 flex-col gap-2 rounded-frame p-3 ${className ?? ''}`}
    >
      <h2 id={`cockpit-${id}`} className="type-label px-1 text-ink-2">
        {title}
      </h2>
      <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto rounded-control bg-surface p-3">
        {children}
      </div>
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
      className="relative isolate flex flex-col gap-4 overflow-hidden rounded-frame bg-sunken p-4 lg:h-[calc(100dvh-8rem)] lg:min-h-[36rem]"
    >
      {/* Full-bleed behind the panels from lg up; below it, an in-flow viewport under the top bar. */}
      <div
        aria-hidden="true"
        data-slot="backdrop"
        className="order-2 h-64 overflow-hidden rounded-control lg:absolute lg:inset-0 lg:-z-10 lg:h-auto lg:rounded-none"
      >
        {backdrop}
      </div>
      <div data-panel="top-bar" className="glass order-1 shrink-0 rounded-frame p-3">
        <div className="rounded-control bg-surface p-2">{topBar}</div>
      </div>
      {status === undefined ? null : <div className="order-1 shrink-0">{status}</div>}
      <div
        data-part="cockpit-middle"
        className="pointer-events-none order-3 grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)_minmax(16rem,24rem)]"
      >
        <Panel id="understood" title="Understood" className="pointer-events-auto lg:max-h-full">
          {understood}
        </Panel>
        {/* The page the run is acting on shows through here; nothing covers it. */}
        <div
          aria-hidden="true"
          data-slot="viewport-window"
          className="pointer-events-none hidden lg:block"
        />
        <Panel id="engine" title="Engine" className="pointer-events-auto lg:max-h-full">
          {engine}
        </Panel>
      </div>
      <Panel id="command" title="Command" className="order-4 shrink-0 lg:max-h-48">
        {command}
      </Panel>
      {announcer}
    </div>
  );
}
