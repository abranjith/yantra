/**
 * Binds every registry leaf to the function that executes it. The
 * `satisfies Record<LeafCommandId, …>` constraint makes a leaf without a
 * binding a `src` typecheck error; a runtime test asserts the same, because
 * test files are outside the typecheck.
 */

import type { LeafCommandId } from '@yantra/protocol';

import { makeAskHandler } from '../commands/ask.js';
import { auditHandler } from '../commands/audit.js';
import { browserHandlers } from '../commands/browser.js';
import { configHandlers } from '../commands/config.js';
import { confirmHandlers } from '../commands/confirm.js';
import { daemonHandlers } from '../commands/daemon.js';
import { makeDoHandler } from '../commands/do.js';
import { makeDoctorHandler } from '../commands/doctor.js';
import { makeInitHandler } from '../commands/init.js';
import { lintHandlers } from '../commands/lint.js';
import { listHandler } from '../commands/list.js';
import { modelHandlers } from '../commands/model.js';
import { openHandlers } from '../commands/open.js';
import { prefsHandler } from '../commands/prefs.js';
import { profileHandler } from '../commands/profile.js';
import { reportHandler } from '../commands/report.js';
import { makeResearchHandler } from '../commands/research.js';
import { makeResumeHandler } from '../commands/resume.js';
import { makeRunHandler } from '../commands/run.js';
import { schedulesHandler } from '../commands/schedule.js';
import { scheduleHandlers, unscheduleHandlers } from '../commands/schedule.js';
import { secretHandlers } from '../commands/secret.js';
import { showHandler } from '../commands/show.js';
import { sitesHandlers } from '../commands/sites.js';
import { templateHandlers } from '../commands/template.js';
import { usageHandler } from '../commands/usage.js';
import type { CommandContext } from '../context/command-context.js';
import type { CliRunOptions } from '../program.js';

import { handler, type HandlerBinding } from './handler.js';

/**
 * Returns the handler table for one program. Runtimes injected through
 * {@link CliRunOptions} are closed over here, so handlers stay
 * commander-shaped.
 */
export function buildHandlers(
  options: CliRunOptions = {},
  context?: CommandContext,
): Readonly<Record<LeafCommandId, HandlerBinding>> {
  return {
    ask: makeAskHandler(options.askRuntime, context),
    research: makeResearchHandler(options.researchRuntime, context),
    do: makeDoHandler(options.doRuntime, context),
    run: makeRunHandler(options.replayRuntime, context),
    resume: makeResumeHandler(options.replayRuntime, context),
    schedules: handler(schedulesHandler),
    list: handler(listHandler),
    show: handler(showHandler),
    usage: handler(usageHandler),
    profile: handler(profileHandler),
    doctor: makeDoctorHandler(options.doctorRuntime, context),
    audit: handler(auditHandler),
    report: handler(reportHandler),
    ...configHandlers(undefined, context),
    ...secretHandlers(undefined, context),
    ...modelHandlers(context),
    prefs: handler(prefsHandler),
    ...sitesHandlers(options.sitesRuntime, context),
    init: makeInitHandler(undefined, context),
    ...confirmHandlers(context),
    ...scheduleHandlers(context),
    ...unscheduleHandlers(context),
    ...daemonHandlers(options.daemonRuntime, context),
    ...lintHandlers(context),
    ...openHandlers(undefined, context),
    ...templateHandlers(options.templateRuntime, context),
    ...browserHandlers(options.browserRuntime, context),
  } satisfies Record<LeafCommandId, HandlerBinding>;
}
