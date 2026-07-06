# Scheduling & the Local Daemon

Yantra can run your saved workflows **unattended** on a recurring schedule — pull
a statement every Monday, check a price each morning — and notify you when a run
finishes or when it needs your consent. A lightweight local daemon does the
firing; there is no cloud, no server, and no privilege escalation. Everything
runs under your own session on your own machine.

> **The one safety rule that governs this whole feature:** a scheduled run that
> reaches a step marked `requires_confirmation` (a purchase, a booking, a submit)
> **pauses and notifies — it never proceeds.** There is no auto-confirm option to
> misconfigure. See [The never-auto-confirm rule](#the-never-auto-confirm-rule).

## Registering a schedule

```bash
# Run the "bank-statement" workflow every Monday at 08:00 (local time)
yantra schedule bank-statement --cron "0 8 * * 1"

# With parameters and a desktop notification
yantra schedule price-check --cron "*/30 * * * *" \
  --params product=WH-1000XM5 --notify desktop

# From a params file, recording notifications to a file only
yantra schedule weekly-report --cron "0 9 * * 1" \
  --params-file ./report.yaml --notify file
```

Registration validates, up front, that the schedule is safe to run unattended:

- the **workflow exists** in your workflow store and **lints clean** (no errors);
- the **cron expression parses** (via [`croner`](https://github.com/hexagon/croner),
  chosen for DST correctness);
- the **params satisfy the workflow's declared params** and contain **no
  credential-shaped literals** (secrets stay in the keychain and resolve at fire
  time, exactly as an interactive `yantra run`).

### Cron examples

| Expression    | Meaning                         |
| ------------- | ------------------------------- |
| `*/5 * * * *` | every 5 minutes                 |
| `0 8 * * 1`   | 08:00 every Monday              |
| `0 9 1 * *`   | 09:00 on the 1st of every month |
| `0 */6 * * *` | every 6 hours, on the hour      |

Five-field (minute-granularity) and six-field (second-granularity) expressions
are both accepted. Times are in your machine's local timezone.

### `--on-confirm`

The `--on-confirm` flag accepts exactly one value — `pause-and-notify` — which is
also the default. Passing anything else (e.g. `--on-confirm auto`) is **rejected
at parse time**. This is deliberate: there is no code path by which a scheduled
run can grant its own consent.

## Listing and removing schedules

```bash
yantra schedules            # table of schedules with their next fire times
yantra schedules --json     # machine-readable
yantra unschedule <id>      # remove a schedule by id
```

`yantra schedules` recomputes each enabled schedule's next fire on demand and
flags any schedule whose last run is **parked awaiting confirmation**.

## The daemon

The daemon is the process that actually fires schedules. It is a thin loop, not a
service you install.

```bash
yantra daemon start              # start in the background (detached)
yantra daemon start --foreground # run in this terminal (Ctrl+C to stop)
yantra daemon status             # running? pid? schedules loaded? pending confirmations?
yantra daemon status --json
yantra daemon stop               # signal the running daemon to shut down gracefully
```

**Lifecycle & guarantees:**

- **Single instance.** A [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile)
  lock ensures only one daemon runs at a time; a second `start` is refused with
  the running pid. A crashed daemon's stale lock is automatically reclaimed.
- **Picks up edits live.** The daemon re-reads your schedules on a 60-second poll,
  so `yantra schedule` / `unschedule` take effect without a restart.
- **No catch-up bursts (missed-fire policy).** Fires that were due while the
  daemon was down are **skipped** and recorded as `missed`, not run late in a
  flood. Browsing tasks rarely want a backlog replayed at once.
- **No self-overlap.** A schedule never runs concurrently with itself; if a prior
  fire is still in flight at the next due time, that fire is skipped and logged.
- **Graceful shutdown.** `stop` (and `SIGTERM`/`SIGINT`) let the in-flight fire
  finish before the lock is released.

**Logs & files** (under `~/.local/share/yantra/`):

| File                     | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `daemon.lock`            | Single-instance lock (managed by `proper-lockfile`).           |
| `daemon.pid`             | PID of the running daemon (used by `stop` / `status`).         |
| `daemon.log`             | Rolling structured (`pino`) daemon log.                        |
| `notifications.jsonl`    | Durable record of every notification, regardless of sink.      |
| `runs/<run-id>/`         | Each fire produces a normal run directory (Brief + artifacts). |
| `index.db` (`schedules`) | The schedule registry.                                         |

> **OS service registration is not part of this feature.** The daemon runs while
> you keep it running. Wiring it into launchd / systemd / Windows Task Scheduler
> is tracked as a follow-up.

## What a fire does

A scheduled fire is _just another connector_ driving the same inline executor an
interactive `yantra run` uses — same ethics gate, same keychain, same stores. It
writes a normal run directory (with the Brief), records the run into your history
index (so it shows in `yantra list`), updates the schedule's last-run status, and
notifies. The only thing different from an interactive run is the **confirmation
connector**: an unattended fire uses the park-and-notify gateway described next.

## The never-auto-confirm rule

When a scheduled fire reaches a step marked `requires_confirmation`:

```
fire → hit flagged step → PARK (checkpoint before the step) → notify → wait
                                                                          │
   you decide, out of band ─────────────────────────────────────────────┘
        │
        ├─ yantra confirm <run-id> grant → daemon resumes the run on its next poll
        └─ yantra confirm <run-id> deny  → run is finalized (handoff, exit 4)
```

1. The run **parks** — the executor checkpoints _before_ the flagged step, so it
   is fully resumable, and the confirmation request stays **pending** on disk.
2. A `confirmation_needed` notification is sent, whose body contains the exact
   command to resolve it: `yantra confirm <run-id> grant`.
3. The schedule's status shows `pending-confirmation` in `yantra schedules` and
   `yantra daemon status`.

The flagged step is **never executed** by an unattended fire — the daemon's
gateway can only ever return "parked", never "granted". Consent can only come
from a human running `yantra confirm`.

When you grant, the daemon picks the parked run up on its next poll and resumes it
unattended-safely — replaying _your_ prior grant exactly once (a second, different
flagged step in the same run would park again rather than be auto-approved).

This rule is enforced in four independent layers:

1. a SQLite `CHECK` constraint pinning `on_confirm` to `pause-and-notify`;
2. the `--on-confirm` flag rejecting any other value at parse time;
3. the daemon confirmation gateway that structurally can only return "parked";
4. a chaos property test asserting a flagged step pauses-and-notifies **100% of
   the time** across injected failures — including a crash between parking and
   notifying, where the notification is re-emitted on restart from the still-
   pending record.

## Notifications

Each fire produces a notification — `completed`, `failed`, or
`confirmation_needed`. The `--notify` target chooses delivery:

| `--notify` | Behavior                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop`  | Best-effort OS-native toast (PowerShell on Windows, `osascript` on macOS, `notify-send` on Linux), degrading to the file record on any failure. |
| `file`     | The durable `notifications.jsonl` record (no toast).                                                                                            |
| `none`     | The `notifications.jsonl` record only, no delivery attempt.                                                                                     |

The durable `notifications.jsonl` record is **always written**, whatever the sink
— so nothing is ever silently lost.

**Notification bodies are secret-free by construction.** A body is templated over
the workflow name, the run status, and artifact paths only — never over your
workflow params or captured page content. There is no code path that interpolates
a param value into a notification.

### Desktop notification troubleshooting

- **Windows:** uses a built-in WinRT toast via PowerShell (no third-party
  module). If PowerShell is restricted, the fire still records to
  `notifications.jsonl`; check there.
- **macOS:** uses `osascript`. The first toast may prompt for notification
  permission for your terminal app.
- **Linux:** requires `notify-send` (from `libnotify`). If it is not installed,
  delivery degrades to the file record.

## Auditing a scheduled run

`yantra audit <run-id>` narrates a scheduled fire — which schedule fired it, on
which cron, and whether it **paused-and-notified for confirmation** (and so never
auto-confirmed). This linkage comes from a small, secret-free `schedule.json`
sidecar written into the run directory by each fire.
