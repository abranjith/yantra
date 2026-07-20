# Site ranking

Yantra keeps a small, local quality signal for websites encountered by both
deterministic and agentic web research. A search result contributes `+1`; a
blocked page, fetch failure, or empty/unreadable extraction contributes `-1`.
Scores are bounded from `-100` to `100` and are collected for future ranking
features; they do not currently change search or synthesis behavior.

Only normalized domain names are stored in the local `index.db`. Yantra never
stores the search query, full URL, page content, or credentials in the ranking
table. Inspect the accumulated data with `yantra sites list` (or add `--json`
for machine-readable output).
