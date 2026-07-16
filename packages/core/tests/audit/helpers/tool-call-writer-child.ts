import { join } from 'node:path';

import { ToolCallWriter } from '../../../src/audit/tool-call-writer.js';

const runDir = process.argv[2];
if (runDir === undefined) throw new Error('runDir argument is required');

const writer = new ToolCallWriter(join(runDir, 'tool-calls.jsonl'));

for (let index = 0; index < 5; index += 1) {
  await writer.append({
    ts: new Date().toISOString(),
    run_id: 'chaos-run',
    session_id: 'chaos-session',
    call_id: `call-${index}`,
    tool: 'status',
    phase: 'start',
    input_sanitized: { index },
    output_sanitized: null,
    status: null,
    duration_ms: null,
    error_code: null,
    confirmation_id: null,
  });
}
process.stdout.write('READY\n');

let index = 5;
setInterval(() => {
  void writer.append({
    ts: new Date().toISOString(),
    run_id: 'chaos-run',
    session_id: 'chaos-session',
    call_id: `call-${index++}`,
    tool: 'status',
    phase: 'start',
    input_sanitized: null,
    output_sanitized: null,
    status: null,
    duration_ms: null,
    error_code: null,
    confirmation_id: null,
  });
}, 1);
