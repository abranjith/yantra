# Workflow Extraction

Extraction is how a run turns a page into data the user keeps. Three paths need
it — the agent reading the page it is on, a replayed workflow's `extract` step,
and web research reading a URL nobody has opened — and they share one pipeline
so the same page never reads three different ways.

This page documents the `extract` step end to end: the shared stages, the
extraction schemas, what a capture becomes, and how a recorded run gets its
terminal read.

## One pipeline, two front doors

```text
a URL nobody opened yet
  └─ ethics ─► fetch ─┐                     processSource()
                      ├─► ReadabilityExtractor ─► htmlToText ─► clean text
an already-open page  │                          normalization
  └─ outerHTML ───────┘                     extractLivePageText()
     + innerText (fallback, live path only)
```

| Stage                                   | File                                               | Role                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `processSource`                         | `packages/core/src/extraction/source-processor.ts` | `ethics → fetch → extract` for a URL. Isolates every failure into a `SourceFailure`. Used by `ask`, `research`, and `web_search`.             |
| `extractLivePageText`                   | `packages/core/src/extraction/live-page.ts`        | `extract` only, for a document the browser already holds. The no-fetch sibling of `processSource`.                                            |
| `ReadabilityExtractor`                  | `packages/core/src/extraction/readability.ts`      | Pre-cleans page chrome (nav, footer, cookie banners, `script`/`style`, infoboxes), then runs Mozilla Readability.                             |
| `htmlToText` / `normalizeExtractedText` | `packages/core/src/extraction/html-to-text.ts`     | Block-structured serialization plus the normalization pass: NBSP and zero-width hygiene, footnote-marker stripping, duplicate-block collapse. |

Both live-page callers go through `extractLivePageText`:

- **the agent's observation digest** — `buildAgentPageSnapshot` /
  `buildObservation` in `packages/core/src/discovery/observe.ts`, which then
  sanitizes and truncates the text before the model may see it;
- **the replayed `extract` step** — `handleExtract` in
  `packages/core/src/executor/step-handlers/extract.ts`, for the
  `primitive/readable` schema.

They previously hand-rolled that stage separately, and diverged: replay returned
`textContent` on a page-level locator — nav, cookie banner, footer, and the
source of every inline `<script>` — while the agent read a Readability digest of
the same page. Sharing the stage is what keeps "what the workflow captures" and
"what the agent read" the same answer.

The one thing the two callers still choose independently is the fallback (see
below): replay passes the element's rendered text, the digest passes none.

## Extraction schemas

`extraction_schema` on an `ExtractStep` declares the shape to read
(`packages/protocol/src/schemas/steps.ts`).

| Schema                                     | Replay behavior                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: primitive, kind: readable }`      | Runs the shared live-page read: Readability's article text, boilerplate stripped. **The right choice for a page-level locator.**                   |
| `{ type: primitive, kind: string }`        | The element's raw `textContent`, trimmed. On `body` that includes nav, footer, and inline script source — correct only when the locator is narrow. |
| `{ type: primitive, kind: number }`        | `parseFloat` of the text with non-numeric characters stripped.                                                                                     |
| `{ type: primitive, kind: boolean }`       | True for `"true"` (case-insensitive) or `"1"`.                                                                                                     |
| `{ type: primitive, kind: date \| money }` | The trimmed text, uninterpreted. Coercion is deliberately left to the consumer.                                                                    |
| `{ type: array, items: … }`                | Each `tr`, `li`, or `[data-row]` descendant read as `items`.                                                                                       |
| `{ type: object, fields: {…} }`            | Per field, the first match of `[data-field="<key>"]`, the positional `td`, or `[class*="<key>"]`.                                                  |

Everything except `readable` runs **in the page** via
`elementHandle.evaluate`, so `extractFromDom` must stay self-contained — a
module-level helper is `undefined` in the browser context.

### `readable` and its fallback

Readability targets prose documents. The pages workflows are recorded against —
a tracking result, an order summary, an app shell — frequently have no article
at all, and an empty capture there would make the terminal read useless on
exactly the pages it exists for. So the live-page stage falls back to the
caller-supplied rendered text.

That text must be `innerText`, not `textContent` or the raw HTML: only the
rendered form reflects what the user could see. `display:none` subtrees and
`<script>` bodies stay out, and block boundaries survive as newlines. It is then
run through `normalizeExtractedText` — the same normalization the article text
received — so the two paths differ in _what_ they select and never in how the
result is cleaned.

The agent's observation digest passes no fallback text, so an article-less page
still digests to `''` as it always has. Wiring one in would change what every
agent run sees and is deliberately left as a separate decision.

## What a capture becomes

`handleExtract` stores an `ExtractionResultEnvelope` under `capture_as`:

```json
{
  "rows": ["Delivered Monday, 07/21/2025 at 2:14 P.M. Left at: Front Door"],
  "metadata": { "total_rows": 1, "valid_rows": 1, "error_count": 0 }
}
```

Rows are lenient-with-evidence: a null or undefined row is kept as
`{ "__error": …, "__raw": … }` and counted in `error_count` rather than failing
the step. `total_rows` always equals `valid_rows + error_count`; the protocol
schema enforces it.

A workflow output unwraps the envelope, so `outputs.json` holds the value rather
than the container:

```yaml
outputs:
  - name: extracted_content_1
    from: '{{ capture.extracted_content_1.rows[0] }}' # a table binds `.rows`
```

`yantra run` prints those outputs beneath the status line, truncating long
values with a pointer to `outputs.json`, and says so explicitly when a workflow
declares none.

## Settling before the read

`handleExtract` calls `settleBeforeRead(ctx)` first, which asks the document its
`readyState` and waits for fetch-driven content to land. An extract is usually
the step right after the click that produces the result, and on a real site that
result arrives seconds later. Without the wait the step reads the pre-click
document and the run reports success having captured a placeholder. See
`packages/core/src/executor/step-handlers/settle-helpers.ts`.

The locator is resolved with `requirement: 'visible'`, not the full actionable
contract. Extraction reads an element; it never points at one. Demanding
actionability would require the element's centre to be in the viewport and to
win a hit test, which a page-length `body` locator can never do.

## Failure semantics

| Situation                   | Result                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| Locator chain exhausted     | `retried` while the step retry budget allows, then `failed` with `locator_not_found`.             |
| DOM extraction threw        | `failed` / `unexpected`.                                                                          |
| Readability threw           | Not a failure. The shared stage degrades to the fallback text; a page read must never fail a run. |
| Extraction returned nothing | Not a failure. Use an `assert` step to require a non-empty capture.                               |
| No browser session          | `failed` / `unexpected`.                                                                          |

## How a recorded run gets its extract step

`promoteAgentTrace` (`packages/core/src/discovery/promote.ts`) drops mid-run
observations as navigation aids and collapses the **trailing** run of reads into
exactly one `extract` step, preferring a real `browser_extract` when present
since it carries the model's declared kind. Because the agent's extract tool has
no located element, promotion synthesizes a deterministic locator — `body` for
content, `table` for a table — and pairs the content case with `readable`:

```yaml
- id: s5
  verb: extract
  locator: s5_locator
  extraction_schema: { type: primitive, kind: readable }
  capture_as: extracted_content_1
```

`promoteDiscoverySession` (the `/discover` path) does not yet emit a terminal
read or outputs.

## The `synthesis:` block

An `extract` step yields raw captured data. A workflow that declares an optional
top-level `synthesis:` block asks `yantra run` to go one step further and
synthesize those reads into a **Brief** — the same `brief.json` / `brief.md` /
`brief.html` trio that `ask`, `research`, and `do` produce:

```yaml
name: quarterly-report
steps:
  - id: s1
    verb: navigate
    url: https://example.com/investors
  - id: s2
    verb: extract
    locator: s2_locator
    extraction_schema: { type: primitive, kind: readable }
    capture_as: extracted_content_1

synthesis:
  goal: What did the quarterly report say about revenue?
  length: medium # short | medium | long   (3 / 6 / 10 key findings)
  detail: standard # overview | standard | full
```

| Field    | Default    | Meaning                                                          |
| -------- | ---------- | ---------------------------------------------------------------- |
| `goal`   | _required_ | The question the Brief answers (1–512 chars). Becomes the query. |
| `length` | `medium`   | Findings/sections budget.                                        |
| `detail` | `standard` | `overview` omits sections; `full` adds a comparison facet table. |

Omitting the block (the default, `synthesis: null`) leaves the run behaving
exactly as before: declared outputs only, no Brief. Every workflow saved before
the block existed therefore replays unchanged.

**Where the sources come from.** Each successful `extract` appends one entry to
the run's bounded evidence ledger
(`packages/core/src/executor/evidence-ledger.ts`) recording the page URL, host,
title, extracted text, and a clock-derived `fetchedAt`. The Synthesize stage
turns those entries into the Brief's numbered sources — the model never supplies
a URL. The ledger keeps at most 32 entries and 256 KB of text, dropping
oldest-first, so a loop that extracts a thousand times cannot exhaust memory or
the prompt budget; any loss is reported as a Brief notice.

Because the Brief is built from extract provenance, declaring `synthesis:` with
no `extract` step produces a sourceless document. `yantra lint` emits a
`SynthesisWithoutExtract` **warning** for that shape — it does not block saving,
since an author may add the read next.

By default the Brief is composed deterministically: no provider session is
opened and replay stays byte-for-byte reproducible. `yantra run --llm <workflow>`
upgrades the wording through the LLM synthesizer, which validates citations and
falls back to the deterministic Brief on any failure. See
[agentic-runtime.md](agentic-runtime.md) for the never-steers invariant that
governs LLM use in replay.

## Tests

| File                                                         | Covers                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/tests/extraction/live-page.spec.ts`           | The shared stage: article preferred over chrome, the fallback and its normalization, the empty-digest contract, never throwing.              |
| `packages/core/tests/extraction/html-to-text.spec.ts`        | Serialization and the normalization pass, including that both halves stay one pass.                                                          |
| `packages/core/tests/extraction/readability.spec.ts`         | The pre-clean and article parsing.                                                                                                           |
| `packages/core/tests/executor/replay-page-settling.spec.ts`  | Real Chrome, end to end: settling before the read, `readable` vs `string`, the article-less fallback, and the value reaching `outputs.json`. |
| `packages/core/tests/executor/step-handlers/extract.spec.ts` | Evidence recording: the appended entry's fields, row serialization, the injected clock, and that a ledger failure never fails the step.      |
| `packages/core/tests/executor/evidence-ledger.spec.ts`       | The ledger's caps: oldest-first eviction, the byte budget, and overflow accounting.                                                          |
| `packages/core/tests/workflow/replay/synthesize.spec.ts`     | The Synthesize stage: strategy selection, ledger → sources mapping, and best-effort failure containment.                                     |
