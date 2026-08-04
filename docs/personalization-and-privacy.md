# Personalization & Privacy

Yantra can tailor results to you — your preferred units, retailers, interests,
and default output shape — **without ever handing your raw activity to a
language model.** This page explains exactly what is stored, where, and how the
privacy guarantee is enforced.

## What is stored, and where

| Data                                                                                                            | Location                                               | Nature                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Agent operational defaults** (model, budgets, retries, confirmation timeout)                                  | `~/.config/yantra/profile.yaml` (`agent.*`)            | Configuration only; never personalization context.                         |
| **Personal defaults** (search provider, detail/length, locale/city/region/units, favorite retailers, interests) | `~/.config/yantra/profile.yaml`                        | Human-editable YAML. This file is **yours** — open it, edit it, delete it. |
| **Sensitive-context grants** (`context.location`)                                                               | `~/.config/yantra/profile.yaml` (`context.*`)          | Which sensitive facts the agent may be told. Asked at `yantra init`.       |
| **Task history** (intent, brief id, status, timing, cost, provider)                                             | `~/.local/share/yantra/index.db` (`history` table)     | A local SQLite index.                                                      |
| **Machine preference signals**                                                                                  | `~/.local/share/yantra/index.db` (`preferences` table) | Learned/managed values; each carries an `approved` flag.                   |
| **Rate-limit buckets**                                                                                          | `~/.local/share/yantra/index.db` (`rate_limits` table) | Per-host token buckets that survive restarts.                              |

Nothing leaves your machine. The index is a **rebuildable cache** — the
canonical run-dir files under `~/.local/share/yantra/runs/` remain the source of
truth. A deleted or corrupted `index.db` is a warning, never data loss;
`yantra doctor` moves a corrupt file aside and rebuilds the history from your run
tree.

## How to inspect and manage it

```bash
yantra profile                 # effective preferences + provenance (profile.yaml vs index.db)
yantra prefs list              # stored machine-layer preferences
yantra prefs set defaults.detail full
yantra prefs get locale.units
yantra prefs approve <key>     # approve a learned signal so it may personalize
yantra prefs --forget <key>    # DELETE a value outright (both layers)
yantra list                    # your recent tasks
yantra usage --since 7d        # cost/volume rollup
```

`profile.yaml` is plain text you can edit or delete by hand. `--forget` performs
a real deletion of the underlying row — not a soft hide.

### Preference precedence

When the same key exists in more than one place, the winner is (highest first):

1. an explicit `yantra prefs set` (a `user` row in the index),
2. your `profile.yaml` value,
3. a machine-`learned` signal.

Flag resolution then layers on top: an explicit CLI flag (e.g. `--detail full`)
always beats the resolved preference, which beats the built-in default.

## The privacy guarantee

> **Raw run history and PII have no code path into an LLM payload.**

Only a short (≤ 400 char), **sanitized, user-approved** preference summary is ever
injected into a prompt — for example:

```
Prefers metric units. Favors retailers: Amazon, Best Buy.
```

This is intentionally the _only_ personalization surface an LLM sees. The
guarantee is enforced by **three independent mechanisms**, so a single mistake
cannot leak your history:

Operational `agent.*` preferences are explicitly excluded even though they are
approved profile values. They configure session construction and enforcement;
they are never summarized into the user-personalization paragraph.

1. **Input-type restriction (structural).** `buildPersonalizationContext` accepts
   an `EffectivePreferences` map and nothing else. There is no overload, field,
   or branch that reads a history row, so raw prior-query text has no way in. The
   result carries a `Sanitized<string>` brand — the only type the synthesizer's
   `personalization` slot will accept, so unsanitized text is a compile error.

2. **Approval gate + sanitization + bound.** Only `approved` preferences
   contribute (your `profile.yaml` and explicit `prefs set` values are approved by
   definition; machine-`learned` signals require `yantra prefs approve`). The
   composed text passes through the single `sanitize()` chokepoint (public
   profile — credential and PII shapes are stripped) and is capped at 400
   characters on a line boundary.

3. **Property test + import-graph guard (verification).** A 500-run property test
   generates PII- and secret-shaped history rows, enables personalization, and
   asserts no history string ever appears in any captured LLM payload. A build-time
   check (`pnpm security:static-check`) walks the import graph of every
   LLM-payload assembler (the synthesizer, the research query generator, the agent
   prompt builders) and fails the build if any of them can even _import_ the
   history/preference store.

Turn personalization off entirely by setting `personalization.enabled: false` in
`profile.yaml` (or `yantra prefs set personalization.enabled false`): no context
is built, ever.

## Ambient context: what the agent is told about the run

Agentic runs (`do`, `research`, `ask`) also receive a small **ambient block** —
facts about the run itself, stated authoritatively so small models do not guess
them from their training prior:

```
Ambient context (authoritative; prefer these values over your training data):
- current date: Wednesday, 2026-08-05
- timezone: America/Chicago (UTC-05:00)
- locale: en-US
- user location: Naperville, IL, US
Facts marked "not available" were not shared. Never guess or derive them; if the
goal depends on one, stop and report it as a blocker.
```

The first three are **host-environment facts** — your clock and your OS locale
settings, not personal data. They are always supplied and are deliberately _not_
grants: making the date deniable would reopen the exact failure the block exists
to prevent.

**Your location is different.** It is genuinely personal, so it is gated by an
explicit grant:

| Key                | Default | Effect                                                                 |
| ------------------ | ------- | ---------------------------------------------------------------------- |
| `context.location` | `true`  | Permits stating the value composed from `locale.city`/`locale.region`. |
| `locale.city`      | `null`  | Free text at city grain, e.g. `"Naperville, IL"`.                      |
| `locale.region`    | `null`  | Country/region grain, e.g. `"US"`.                                     |

```bash
yantra prefs set locale.city "Naperville, IL"
yantra prefs set context.location false   # withhold it
yantra prefs set context.location true    # grant it again
```

### Where the grant is first collected

`yantra init` asks for it, so the first answer is an explicit choice rather than
a default you never saw:

> Share your location with the agent? Without it, Yantra will ask you to name a
> location in queries like 'hotels near me' rather than guessing one.

Answering yes chains one more question — _"City or area (e.g. Naperville, IL) —
leave blank to set later"_. Declining skips it entirely. Date, timezone, and
locale are not asked about; they are always supplied.

The questionnaire fires only when **all** of these hold: stdin is an interactive
TTY, neither `--json` nor `--yes` was passed, and the profile is actually being
written (absent, or `--reset`). **CI and scripted use are therefore unaffected —
a non-TTY implies `--yes`** — and a re-run over an existing profile never asks a
question whose answer would be discarded. Cancelling (Ctrl-C) falls back to the
defaults rather than failing the command.

The grant defaults to `true` because it is behavior-preserving: with no city
configured the block still renders `- user location: not available`, so an
untouched install is unchanged.

Three properties are worth stating plainly:

- **Denied and unconfigured are indistinguishable to the model.** Both render
  `not available`. The model's correct behavior is identical either way, and
  distinguishing them would leak that you hold a value you are withholding. The
  _user-facing_ remedy does distinguish them — a location handoff tells you to
  set `locale.city` or to re-enable `context.location`, whichever applies.
- **The value goes through the same chokepoint as personalization.**
  `resolveUserLocation` reads only approved rows, sanitizes through the single
  `sanitize()` entry point, caps at 120 characters, and returns a
  `Sanitized<string>` — the only type the ambient block's location slot accepts,
  so an unvetted value is a compile error.
- **The agent may not derive what it was not given.** The system prompt forbids
  inferring your location from ambient signals such as the timezone. A goal that
  needs a location it does not have fails fast with a handoff (exit 4) instead
  of proceeding on a guess.
