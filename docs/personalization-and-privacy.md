# Personalization & Privacy

Yantra can tailor results to you — your preferred units, retailers, interests,
and default output shape — **without ever handing your raw activity to a
language model.** This page explains exactly what is stored, where, and how the
privacy guarantee is enforced.

## What is stored, and where

| Data                                                                                                | Location                                               | Nature                                                                     |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Agent operational defaults** (model, budgets, retries, confirmation timeout)                      | `~/.config/yantra/profile.yaml` (`agent.*`)            | Configuration only; never personalization context.                         |
| **Personal defaults** (search provider, detail/length, locale/units, favorite retailers, interests) | `~/.config/yantra/profile.yaml`                        | Human-editable YAML. This file is **yours** — open it, edit it, delete it. |
| **Task history** (intent, brief id, status, timing, cost, provider)                                 | `~/.local/share/yantra/index.db` (`history` table)     | A local SQLite index.                                                      |
| **Machine preference signals**                                                                      | `~/.local/share/yantra/index.db` (`preferences` table) | Learned/managed values; each carries an `approved` flag.                   |
| **Rate-limit buckets**                                                                              | `~/.local/share/yantra/index.db` (`rate_limits` table) | Per-host token buckets that survive restarts.                              |

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
