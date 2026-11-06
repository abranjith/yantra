/**
 * Binds every registry leaf to the function that executes it. The
 * `satisfies Record<LeafCommandId, …>` constraint makes a leaf without a
 * binding a `src` typecheck error; a runtime test asserts the same, because
 * test files are outside the typecheck.
 */

import type { LeafCommandId } from '@yantra/protocol';

import { makeAskHandler } from '../commands/ask.js';
import { auditHandler } from '../commands/audit.js';
import { configHandlers } from '../commands/config.js';
import { makeDoHandler } from '../commands/do.js';
import { makeDoctorHandler } from '../commands/doctor.js';
import { makeInitHandler } from '../commands/init.js';
import { listHandler } from '../commands/list.js';
import { modelHandlers } from '../commands/model.js';
import { prefsHandler } from '../commands/prefs.js';
import { profileHandler } from '../commands/profile.js';
import { reportHandler } from '../commands/report.js';
import { makeResearchHandler } from '../commands/research.js';
import { resumeHandler } from '../commands/resume.js';
import { runHandler } from '../commands/run.js';
import { schedulesHandler } from '../commands/schedule.js';
import { secretHandlers } from '../commands/secret.js';
import { showHandler } from '../commands/show.js';
import { sitesHandlers } from '../commands/sites.js';
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
    resume: handler(resumeHandler),
    schedules: handler(schedulesHandler),
    'daemon.status': LEGACY_ONLY,
    list: handler(listHandler),
    show: handler(showHandler),
    usage: handler(usageHandler),
    profile: handler(profileHandler),
    'template.list': LEGACY_ONLY,
    'template.show': LEGACY_ONLY,
    doctor: makeDoctorHandler(),
    audit: handler(auditHandler),
    report: handler(reportHandler),
    'browser.list': LEGACY_ONLY,
    ...configHandlers(),
    ...secretHandlers(),
    ...modelHandlers(),
    prefs: handler(prefsHandler),
    ...sitesHandlers(options.sitesRuntime),
    init: makeInitHandler(),
  } satisfies Record<LeafCommandId, HandlerBinding>;
}
