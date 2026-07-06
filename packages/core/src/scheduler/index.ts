/**
 * Scheduler — the local daemon that fires saved workflows on their cron
 * schedules, unattended (FEAT-021).
 *
 * A scheduled fire is just another `ConnectorIO` constructing a `Task` and
 * driving the same inline executor (plan §7); the daemon is a thin `croner`
 * loop + `proper-lockfile` single-instance guard + notification sink — not a
 * server rewrite. The never-auto-confirm rule (plan §6) is embodied in the
 * daemon's confirmation gateway, which parks-and-notifies rather than ever
 * granting consent.
 */

export { nextFire, nextFireIso, validateCron, type CronValidation } from './cron.js';
export {
  FileDaemonLock,
  DaemonLockHeldError,
  daemonLockPath,
  daemonPidPath,
  type DaemonLock,
  type DaemonLockInfo,
} from './daemon-lock.js';
export {
  SchedulerDaemon,
  type DaemonClock,
  type DaemonStatus,
  type FireFn,
  type FireResult,
  type ResumeParkedFn,
  type SchedulerDaemonDeps,
} from './daemon.js';
export {
  DaemonConfirmationGateway,
  type DaemonConfirmationGatewayDeps,
} from './daemon-confirmation-gateway.js';
export {
  PreGrantedConfirmationGateway,
  type PreGrantedConfirmationGatewayOptions,
} from './pregranted-confirmation-gateway.js';
export {
  runScheduledFire,
  type FireRunDriver,
  type FireRunOutcome,
  type FireRunnerDeps,
} from './fire-runner.js';
export {
  resolveParkedRun,
  type ConfirmationDecisionReader,
  type ParkedResolverDeps,
  type ResumeDriver,
} from './parked-resolver.js';
export { SCHEDULE_LINK_FILE, writeScheduleLink, type ScheduleLink } from './schedule-link.js';
export {
  SinkNotifier,
  buildNotification,
  desktopCommand,
  notificationsPath,
  type Notification,
  type NotificationInput,
  type NotificationKind,
  type Notifier,
  type SinkNotifierDeps,
} from './notify.js';
