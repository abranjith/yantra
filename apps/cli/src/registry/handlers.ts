/**
 * Binds every registry leaf to the function that executes it. The
 * `satisfies Record<LeafCommandId, …>` constraint makes a leaf without a
 * binding a `src` typecheck error; a runtime test asserts the same, because
 * test files are outside the typecheck.
 */

import type { LeafCommandId } from '@yantra/protocol';

import { makeAskHandler } from '../commands/ask.js';
import { auditHandler } from '../commands/audit.js';
import { makeDoHandler } from '../commands/do.js';
import { makeDoctorHandler } from '../commands/doctor.js';
import { listHandler } from '../commands/list.js';
import { profileHandler } from '../commands/profile.js';
import { reportHandler } from '../commands/report.js';
import { makeResearchHandler } from '../commands/research.js';
import { resumeHandler } from '../commands/resume.js';
import { runHandler } from '../commands/run.js';
import { schedulesHandler } from '../commands/schedule.js';
import { showHandler } from '../commands/show.js';
import { usageHandler } from '../commands/usage.js';
import type { CliRunOptions } from '../program.js';

import { handler, LEGACY_ONLY, type HandlerBinding } from './handler.js';

/**
 * Returns the handler table for one program. Runtimes injected through
 * {@link CliRunOptions} are closed over here, so handlers stay
 * commander-shaped.
 */
export function buildHandlers(
  options: CliRunOptions = {},
): Readonly<Record<LeafCommandId, HandlerBinding>> {
  return {
    ask: makeAskHandler(options.askRuntime),
    research: makeResearchHandler(options.researchRuntime),
    do: makeDoHandler(options.doRuntime),
    run: handler(runHandler),
    'config.path': LEGACY_ONLY,
    'config.list': LEGACY_ONLY,
    'config.get': LEGACY_ONLY,
    'config.validate': LEGACY_ONLY,
    resume: handler(resumeHandler),
    schedules: handler(schedulesHandler),
    'daemon.status': LEGACY_ONLY,
    list: handler(listHandler),
    'model.list': LEGACY_ONLY,
    show: handler(showHandler),
    usage: handler(usageHandler),
    profile: handler(profileHandler),
    'sites.list': LEGACY_ONLY,
    'template.list': LEGACY_ONLY,
    'template.show': LEGACY_ONLY,
    doctor: makeDoctorHandler(),
    audit: handler(auditHandler),
    report: handler(reportHandler),
    'browser.list': LEGACY_ONLY,
  } satisfies Record<LeafCommandId, HandlerBinding>;
}
