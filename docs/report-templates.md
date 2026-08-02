# Report Templates

Report templates let Yantra write a model-assisted result in your own Markdown
structure. The model fills typed slots; Yantra keeps the surrounding headings,
labels, and source section exactly where you authored them.

## File format

A template is a Markdown file with optional YAML frontmatter:

```markdown template
---
name: exec-brief
description: Weekly executive brief
guidance: British English. CFO audience. Never speculate beyond the sources.
tags: [work, weekly]
---

# {{ title | text }}

## Executive Summary

<!-- guidance:
Lead with the headline revenue number, then explain the driver
in one sentence. Name the segment, not the region.
-->

{{ summary | markdown, max_words=200 }}

## Key Risks

{{ risks | list, min=3, max=5 }}

## Vendor Comparison

{{ comparison | table(Vendor, Price, Notes) }}

## Sources

{{ sources }}
```

Names and tags are stored as lowercase slugs. Tags are deduplicated and sorted.
`description` is for humans browsing `template list`; `guidance` is for the model
writing the report. Both are optional.
The `sources` key is reserved: Yantra fills it from the evidence ledger, and the
model cannot supply or replace source URLs.

## Slot syntax

Slots use `{{ key }}` or `{{ key | kind, constraint=value }}`. An unqualified
slot defaults to `markdown`.

| Kind       | Model value      | Rendered Markdown                      |
| ---------- | ---------------- | -------------------------------------- |
| `text`     | string           | text inserted verbatim                 |
| `markdown` | string           | Markdown prose inserted verbatim       |
| `list`     | array of strings | one `- item` bullet per value          |
| `table`    | array of rows    | a GFM table with the declared columns  |
| `sources`  | engine-owned     | numbered sources from fetched evidence |

Table columns are declared inside the kind:

```markdown template
# Vendor Review

## Comparison

{{ vendors | table(Vendor, Price, Notes), min=1, max=10 }}

## Sources

{{ sources }}
```

## Template library commands

Create and validate a starter template:

```console
yantra template new weekly --tags work,weekly
yantra template lint weekly
```

Import an existing file only after it parses successfully:

```console
yantra template save ./exec.md --name exec-brief --tags work,weekly
```

Manage the library with:

```console
yantra template list
yantra template list --tag work
yantra template show exec-brief
yantra template lint ./draft.md
yantra template remove exec-brief
```

Every subcommand accepts `--json`. `save` refuses an existing name unless
`--force` is passed, and an invalid input file is never copied into the library.
When guidance is present, human `lint` and `show` output truncates slot guidance
to 32 code points and the document note to about 72. Their `--json` envelopes
always carry the complete, untruncated guidance text.

## Constraints

String slots (`text` and `markdown`) accept `min_chars`, `max_chars`,
`min_words`, and `max_words`. Collection slots (`list` and `table`) accept
`min` and `max`, counting list items or table rows. Bounds are inclusive,
non-negative integers, and a minimum cannot exceed its matching maximum.

```markdown template
---
name: incident-update
tags: [operations]
---

# {{ title | text, min_chars=5, max_chars=100 }}

## Situation

{{ situation | markdown, min_words=20, max_words=250 }}

## Actions

{{ actions | list, min=1, max=8 }}

## Owners

{{ owners | table(Owner, Action, Due), min=1, max=12 }}

## Evidence

{{ sources }}
```

Slot keys start with a lowercase letter, contain only lowercase letters,
digits, and underscores, and are at most 48 characters. Every key is unique.
Templates need at least one slot. `sources` may appear once and cannot be given
another kind; a table needs at least one named column.

The parser applies the same rules throughout the Markdown body. It does not
special-case fenced code blocks: headings, placeholders, and guidance directives
inside a fence are parsed as real template syntax. Ordinary HTML comments such
as `<!-- TODO -->` remain in the renderable body.

## Author guidance

Guidance gives the model advisory writing instructions without changing the
rendered structure or adding runtime validation. Use numeric constraints when a
length or item count must be enforced.

There are two forms:

- Frontmatter `guidance:` applies once to the whole document. It is useful for
  audience, voice, locale, and evidence rules.
- A whole-line `<!-- guidance: ... -->` directive applies to the next
  placeholder. It can be single-line or span several lines as in the example
  above. Blank lines and headings between the directive and slot do not break
  the binding; when a line has several placeholders, only the first receives it.

A directive must occupy its own complete line or lines. Only horizontal
whitespace may precede `<!--` or follow the closing `-->`. A directive cannot
bind to the engine-owned `sources` slot; use frontmatter guidance for a note that
concerns the evidence ledger or the document as a whole.

Yantra collapses whitespace before sending guidance to the model. Slot guidance
is limited to 500 Unicode code points and document guidance to 1,000. Guidance
cannot contain `{{` or `}}`, or raw ANSI escape bytes. These rules prevent
guidance from looking like an unresolved placeholder or injecting terminal
control data into the generated model schema.

Guidance is never report content. The parser removes directive lines before it
stores the renderable body, and only the stripped body reaches the Markdown and
HTML renderers. Editing guidance still changes the template provenance hash.

`template lint` reports guidance errors with these messages (the character count
`N` is the normalized Unicode code-point length):

- `guidance directive is not followed by a slot; move it above a model-filled slot or use frontmatter guidance for document-level notes`
- `guidance cannot be attached to the reserved sources slot; use frontmatter guidance for document-level notes`
- `unterminated guidance directive: expected "-->"`
- `guidance directive must end its line at "-->"`
- `guidance directives must occupy their own line(s)`
- `guidance text must not be empty`
- `guidance exceeds the 500 character limit (N)` for slot guidance, or
  `guidance exceeds the 1000 character limit (N)` for document guidance
- `guidance must not contain template placeholder syntax ("{{" or "}}")`
- `guidance must not contain raw ANSI escape bytes`
- `a second guidance directive precedes the same slot (first on line N)`
- `frontmatter guidance must be a string`

Because fenced code blocks are not a separate parser mode, a guidance directive
inside one is also stripped and binds positionally. Avoid template-looking
syntax in examples that should render literally.

## Using a template

The same flag is available on all three agentic commands:

```console
yantra ask "summarize this week's delivery status" --template exec-brief
yantra research "compare the shortlisted vendors" --template tag:work
yantra do "prepare the launch review" --template ./templates/launch.md
```

References resolve in this order:

1. An explicit `path:`, `name:`, or `tag:` prefix.
2. A path-shaped value: it contains a path separator, starts with `.`, or ends
   in `.md`.
3. An exact saved template name.
4. A saved-template tag.

A tag with one match resolves automatically. Multiple matches prompt on an
interactive terminal; non-interactive and JSON callers receive an exit-1 error
listing the matches. An unknown reference lists the available saved names.

Templates require LLM mode because the model fills the declared slots.
Combining `--template` with `--no-llm`, or setting `LLM_PROVIDER=none`, exits 1
before a run begins. Saved workflow replay does not support templates yet;
`yantra run x --template y` gives a pointed error instead of treating the flag
as unknown.

## Output formats and artifacts

Template runs support the same `--format terminal|md|html|json` and `--open`
surface as ordinary `ask` and `research` output:

- `terminal` and `md` write the canonical rendered Markdown.
- `html` writes the self-contained inert HTML representation.
- `json` writes a stable schema envelope with `kind: "templated_report"` and
  the report fields, so tools such as `jq .title` work directly.
- `--open` opens `document.html`.

The canonical run artifacts are `document.json`, `document.md`, and
`document.html`. The name deliberately avoids `report.*`, which belongs to the
run's operational audit report. Explicit `--detail` and `--length` flags print
a one-line warning in template mode because the authored structure and slot
constraints control those concerns; stdout remains clean.

## Why Yantra renders your template

The model returns slot values, not a rewritten Markdown document. Yantra keeps
the authored headings and labels stable, inserts lists and tables
deterministically, attaches the engine-owned evidence ledger, validates citation
numbers and URLs, and rejects leftover placeholders or terminal control bytes.
Author guidance directives are removed at parse time, so their text is
structurally absent from both `document.md` and `document.html`.
HTML is escaped before Markdown parsing, allows only HTTP(S) links, and loads no
remote resources. This division makes structural drift unrepresentable and
prevents a model from replacing the evidence section or the surrounding layout.

`document.html` uses the same self-contained theme as `brief.html`: no scripts,
no remote fonts or images, one inlined stylesheet that adapts to the reader's
light or dark scheme, and a print stylesheet that expands source links to their
full URLs. Blockquotes, fenced code, and multi-line table cells render as
authored. When the template body opens without a heading, the report title is
promoted to an `<h1>` so the page is not untitled on screen.
