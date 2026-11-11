# Spike S2 — detached worker and recovery

Throwaway evidence harness for FEAT-064 TASK-001. It is **not product code** and is not run by
`pnpm test`. The findings and verdict are in
`.spec-lite/features/FEAT-064-run_ownership_channel_reconciliation/spike_s2_report.md`; the
scenarios are re-encoded as permanent tests in TASK-005 to TASK-014.

## Running it

```sh
pnpm exec turbo run build --filter=@yantra/core   # the actors import the real identity modules
node e2e/spikes/s2-worker-recovery/run-spike.mjs --out results.json --summary summary.md
node e2e/spikes/s2-worker-recovery/run-spike.mjs --only 3,5 --chrome "<chrome executable>"
```

The harness exits 0 even when a check fails: a failed check is a finding for the report. CI runs
it on Linux, macOS and Windows through the temporary `.github/workflows/spike-s2.yml`.

## Layout

| Path                  | Role                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `run-spike.mjs`       | Runs scenarios 1–6 and writes JSON results plus a markdown table                                |
| `actors/worker.mjs`   | Toy run owner: link-claimed lease, token-first socket, persist-before-publish log, toy D12 item |
| `actors/launcher.mjs` | The detached spawn helper (`direct`, `trampoline` double spawn, Windows `wmi`)                  |
| `actors/host.mjs`     | Toy host: reads the lease, attaches, replays from `from_seq`, follows live                      |
| `actors/job.ps1`      | Windows Job object probe, kill-on-close harness and console `WM_CLOSE`                          |
| `actors/sleeper.mjs`  | Unrelated live process for the forged reused-PID check                                          |
| `lib/frame.mjs`       | `[type: u8][length: u32 BE][payload]` codec with header-first limits                            |
| `lib/channel.mjs`     | Event log, socket placement, run socket server with the replay-to-live watermark                |
| `lib/util.mjs`        | Kill, wait, exclusive-publish and atomic-replace helpers                                        |

User text never reaches a worker's argv: everything travels in the owner-only launch file.
