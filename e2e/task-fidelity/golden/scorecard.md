# Task-fidelity scorecard

- Model: `fixture/scripted-agent`
- Prompt: `agent-v10`
- Runs per scenario: 2
- Generated: 2026-10-11T00:00:00.000Z

Scores are medians across runs; `—` means not measured (a zero denominator). Scores are observational and never gate CI.

## Scores

| Scenario | Coverage | Constraints | Sources | Citations | Honesty | Stability (Jaccard) | Same top-5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| listing-table | 1.00 | 1.00 | 1.00 | 1.00 | — | 1.00 | 2/2 |
| multi-table | 0.00 | 1.00 | 1.00 | — | — | 1.00 | 2/2 |

## Cost (medians)

| Scenario | Turns | Wall (s) | Cost (USD) | Navigations | Browser launches | Interaction required |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| listing-table | 14 | 0.0 | 0.0000 | 9 | 0 | 0 |
| multi-table | 2 | 0.0 | 0.0000 | 1 | 0 | 0 |

Totals: 4 runs, 0.0 s, $0.0000, 20 navigations, 0 browser launches.

## Per-run detail

### listing-table — run 1 (`run-1`, published)

- **Coverage** 1.00 (20/20)
- **Constraints** 1.00 (5/5)
- **Sources** 1.00 (5/5)
- **Citations** 1.00 (20/20)
- **Honesty** — (0/0)
- **Delivered rows** itm-08, itm-03, itm-13, itm-01, itm-10

### listing-table — run 2 (`run-2`, published)

- **Coverage** 1.00 (20/20)
- **Constraints** 1.00 (5/5)
- **Sources** 1.00 (5/5)
- **Citations** 1.00 (20/20)
- **Honesty** — (0/0)
- **Delivered rows** itm-08, itm-03, itm-13, itm-01, itm-10

### multi-table — run 1 (`run-3`, published)

- **Coverage** 0.00 (0/1)
  - towing-summit-awd: missing towing
- **Constraints** 1.00 (1/1)
- **Sources** 1.00 (1/1)
- **Citations** — (0/0)
  - nothing was cited
- **Honesty** — (0/0)
- **Delivered rows** towing-summit-awd

### multi-table — run 2 (`run-4`, published)

- **Coverage** 0.00 (0/1)
  - towing-summit-awd: missing towing
- **Constraints** 1.00 (1/1)
- **Sources** 1.00 (1/1)
- **Citations** — (0/0)
  - nothing was cited
- **Honesty** — (0/0)
- **Delivered rows** towing-summit-awd
