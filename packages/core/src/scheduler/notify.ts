/**
 * Notification sinks for scheduled fires (FEAT-021 TASK-005).
 *
 * Every fire — success, failure, or a parked confirmation — produces a
 * {@link Notification}. Sinks deliver it:
 *   - `file`    → append to `notifications.jsonl` (always written as the durable
 *                 record, regardless of the selected sink),
 *   - `desktop` → best-effort OS-native toast (zero-dep: PowerShell / osascript /
 *                 notify-send), degrading to `file` on any failure,
 *   - `none`    → the jsonl record only, no delivery.
 *
 * **Bodies are secret/PII-free by construction** (plan §6): a notification is
 * built from a fixed template over the workflow name, status, and artifact
 * paths — never from workflow params or captured content. {@link buildNotification}
 * is the only constructor, so params can't leak into a body.
 */

import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { generateUlid } from '@yantra/protocol';

import { dataDir } from '../browser/paths.js';
import type { Logger } from '../browser/types.js';
import type { NotifyTarget } from '../index-db/schedule-store.js';

/** The kind of event a notification reports. */
export type NotificationKind = 'completed' | 'failed' | 'confirmation_needed';

/** A durable, secret-free notification record (one jsonl line). */
export interface Notification {
  readonly id: string;
  readonly schedule_id: string;
  readonly run_id: string | null;
  readonly kind: NotificationKind;
  readonly title: string;
  /** Short body — workflow name + status + paths only. No secrets/PII. */
  readonly body: string;
  readonly created_at: string;
}

/** Inputs to {@link buildNotification} — only safe, non-secret fields. */
export interface NotificationInput {
  readonly scheduleId: string;
  readonly runId: string | null;
  readonly workflowName: string;
  readonly kind: NotificationKind;
  /** Optional path to the run's brief/report, surfaced in the body. */
  readonly artifactPath?: string | null;
  /** For `confirmation_needed`: the exact command to resolve it. */
  readonly confirmCommand?: string | null;
}

/** Path to the durable notifications log. */
export function notificationsPath(): string {
  return join(dataDir(), 'notifications.jsonl');
}

/**
 * Builds a secret-free notification from safe fields only. This is the **single
 * constructor** — there is no code path that interpolates workflow params or
 * captured content into a body (plan §6 secret-free-by-construction).
 */
export function buildNotification(input: NotificationInput, now: Date = new Date()): Notification {
  const title = titleFor(input.kind, input.workflowName);
  const body = bodyFor(input);
  return {
    id: generateUlid(),
    schedule_id: input.scheduleId,
    run_id: input.runId,
    kind: input.kind,
    title,
    body,
    created_at: now.toISOString(),
  };
}

function titleFor(kind: NotificationKind, workflowName: string): string {
  switch (kind) {
    case 'completed':
      return `Yantra: "${workflowName}" completed`;
    case 'failed':
      return `Yantra: "${workflowName}" failed`;
    case 'confirmation_needed':
      return `Yantra: "${workflowName}" needs your confirmation`;
  }
}

function bodyFor(input: NotificationInput): string {
  switch (input.kind) {
    case 'completed':
      return input.artifactPath
        ? `Scheduled run finished. Brief: ${input.artifactPath}`
        : 'Scheduled run finished.';
    case 'failed':
      return input.artifactPath
        ? `Scheduled run failed. Report: ${input.artifactPath}`
        : 'Scheduled run failed.';
    case 'confirmation_needed':
      return input.confirmCommand
        ? `A scheduled run is paused for consent. Resolve with: ${input.confirmCommand}`
        : 'A scheduled run is paused, awaiting your confirmation.';
  }
}

/**
 * Delivers notifications to a selected sink. The durable jsonl record is written
 * for **every** notification regardless of the sink, so `yantra schedules` can
 * always surface the daemon-side inbox.
 */
export interface Notifier {
  notify(notification: Notification, target: NotifyTarget): Promise<void>;
}

/** Injectable spawn function (for testing the desktop sink without real toasts). */
export type SpawnFn = typeof spawn;

/** Constructor dependencies for {@link SinkNotifier}. */
export interface SinkNotifierDeps {
  readonly logger?: Logger;
  /** Override the jsonl path (tests). */
  readonly jsonlPath?: string;
  /** Injectable spawn for the desktop sink (tests). */
  readonly spawnFn?: SpawnFn;
  /** Injectable platform string (tests); defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** Default {@link Notifier}: jsonl always, plus best-effort desktop. */
export class SinkNotifier implements Notifier {
  private readonly logger: Logger | null;
  private readonly jsonlPath: string;
  private readonly spawnFn: SpawnFn;
  private readonly platform: NodeJS.Platform;

  public constructor(deps: SinkNotifierDeps = {}) {
    this.logger = deps.logger ?? null;
    this.jsonlPath = deps.jsonlPath ?? notificationsPath();
    this.spawnFn = deps.spawnFn ?? spawn;
    this.platform = deps.platform ?? process.platform;
  }

  public async notify(notification: Notification, target: NotifyTarget): Promise<void> {
    // Always write the durable record first.
    await this.appendJsonl(notification);

    if (target === 'desktop') {
      const delivered = await this.tryDesktop(notification);
      if (!delivered) {
        this.logger?.warn?.(
          { id: notification.id },
          'desktop notification failed; recorded to notifications.jsonl only',
        );
      }
    }
    // `file` and `none` need no extra delivery — the jsonl record is the sink.
  }

  /** Appends the durable jsonl record (best-effort — never throws). */
  private async appendJsonl(notification: Notification): Promise<void> {
    try {
      await mkdir(dirname(this.jsonlPath), { recursive: true, mode: 0o700 });
      await appendFile(this.jsonlPath, JSON.stringify(notification) + '\n', 'utf8');
    } catch (error) {
      this.logger?.warn?.(
        { id: notification.id, error: error instanceof Error ? error.message : String(error) },
        'failed to append notifications.jsonl',
      );
    }
  }

  /**
   * Best-effort OS-native toast. Returns true on a spawn that exits 0, false on
   * any failure (missing tool, non-zero exit, unsupported platform) so the
   * caller can record the degrade.
   */
  private tryDesktop(notification: Notification): Promise<boolean> {
    const command = desktopCommand(this.platform, notification);
    if (command === null) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      try {
        const child = this.spawnFn(command.file, command.args, { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }
}

/** Builds the platform-appropriate desktop-notification command, or null. */
export function desktopCommand(
  platform: NodeJS.Platform,
  notification: Notification,
): { file: string; args: string[] } | null {
  const title = sanitizeForShell(notification.title);
  const body = sanitizeForShell(notification.body);

  if (platform === 'darwin') {
    return {
      file: 'osascript',
      args: ['-e', `display notification "${body}" with title "${title}"`],
    };
  }
  if (platform === 'linux') {
    return { file: 'notify-send', args: [title, body] };
  }
  if (platform === 'win32') {
    // Raw WinRT toast via PowerShell — no third-party module (BurntToast-free).
    const script = powershellToast(title, body);
    return {
      file: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
    };
  }
  return null;
}

/** Strips quotes/backticks/newlines so a title/body can't break out of the command. */
function sanitizeForShell(text: string): string {
  return text.replace(/["'`\r\n]/g, ' ').slice(0, 200);
}

/** A minimal WinRT toast script (title + body only). */
function powershellToast(title: string, body: string): string {
  return [
    '$ErrorActionPreference = "SilentlyContinue";',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;',
    '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
    '$texts = $template.GetElementsByTagName("text");',
    `$texts.Item(0).AppendChild($template.CreateTextNode("${title}")) | Out-Null;`,
    `$texts.Item(1).AppendChild($template.CreateTextNode("${body}")) | Out-Null;`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($template);',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Yantra").Show($toast);',
  ].join(' ');
}
