# Form benchmark

> User waiver (2026-10-19): OpenCode Go live testing is excluded from the feature completion gate. This report contains only 109 of the planned 320 measured runs. The remaining 211 were not run. It does not establish generality or latency targets. Automatic collection has stopped.

Targets are observational. True success uses independent fixture state; reported success is the run outcome.

## opencode-go/deepseek-v4-pro/high

| Layout / phase                       | True  | Reported | False fulfilled | Wall p50 / p95 ms | Tool p50 / p95 ms | Reasoning p50 / p95         | Correctness | Retries | Captures | Delta success / p50 / p95 ms |
| ------------------------------------ | ----- | -------- | --------------- | ----------------- | ----------------- | --------------------------- | ----------- | ------- | -------- | ---------------------------- |
| bench-form-css-order-grid / before   | 0/16  | 15       | 15              | 193561.5 / 586301 | 33441 / 50285     | not recorded / not recorded | 1           | 1       | 0        | -                            |
| bench-form-over-cap / after          | 19/20 | 19       | 0               | 312362 / 414209   | 155876 / 170464   | 11093.5 / 17119             | 1           | 0       | 1        | -                            |
| bench-form-repeated-sections / after | 5/5   | 5        | 0               | 106284 / 297281   | 16607 / 18727     | 9249 / 18460                | 1           | 0       | 1        | -                            |
| bench-form-table-label-cell / before | 0/20  | 20       | 20              | 180092 / 272646   | 39744.5 / 58084   | not recorded / not recorded | 1           | 2       | 0        | -                            |

## opencode-go/deepseek-v4-pro/medium

| Layout / phase                       | True  | Reported | False fulfilled | Wall p50 / p95 ms | Tool p50 / p95 ms | Reasoning p50 / p95         | Correctness | Retries | Captures | Delta success / p50 / p95 ms |
| ------------------------------------ | ----- | -------- | --------------- | ----------------- | ----------------- | --------------------------- | ----------- | ------- | -------- | ---------------------------- |
| bench-form-css-order-grid / before   | 0/16  | 16       | 16              | 206238.5 / 395899 | 32195.5 / 54120   | not recorded / not recorded | 1           | 1.5     | 0        | -                            |
| bench-form-over-cap / after          | 12/12 | 12       | 0               | 283835 / 375798   | 151463.5 / 167231 | 9750.5 / 23715              | 1           | 0       | 1        | -                            |
| bench-form-table-label-cell / before | 0/20  | 20       | 20              | 173817 / 332324   | 30498 / 42681     | not recorded / not recorded | 1           | 1       | 0        | -                            |

## Targets

| Target           | Met | Detail                                                                                                                                                                    |
| ---------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| per-cell-success | no  | opencode-go/deepseek-v4-pro/high bench-form-repeated-sections: 5/5 (insufficient runs); opencode-go/deepseek-v4-pro/medium bench-form-over-cap: 12/12 (insufficient runs) |
| layouts          | no  | 1 layouts meet 95%                                                                                                                                                        |
| models           | no  | Requires two settings meeting 95% on the same three layouts                                                                                                               |
| p50              | no  | Every after cell: p50 <= 120000 ms; missing timing is unmet                                                                                                               |
| p95              | no  | Every after cell: p95 <= 300000 ms; missing timing is unmet                                                                                                               |

## Inputs

- e2e/task-fidelity/baselines/2026-10-do-benchmark-partial-before-deepseek-v4-pro-high.json: before, opencode-go/deepseek-v4-pro/high, agent-v10, commit d737ba44ad80509ec67e587eea69951221c6b5d6
- e2e/task-fidelity/baselines/2026-10-do-benchmark-partial-before-deepseek-v4-pro-medium.json: before, opencode-go/deepseek-v4-pro/medium, agent-v10, commit d737ba44ad80509ec67e587eea69951221c6b5d6
- e2e/task-fidelity/baselines/2026-10-do-benchmark-partial-after-deepseek-v4-pro-high.json: after, opencode-go/deepseek-v4-pro/high, agent-v15, commit 204bb9b0e263570d91355d6a903fc5bc4d075e54
- e2e/task-fidelity/baselines/2026-10-do-benchmark-partial-after-deepseek-v4-pro-medium.json: after, opencode-go/deepseek-v4-pro/medium, agent-v15, commit 204bb9b0e263570d91355d6a903fc5bc4d075e54
