import { describe, expect, it } from 'vitest';

import { scriptRunSpec } from '../../../../src/adapters/pi/tools/script-run.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';

import { buildServices } from './test-support.js';

describe('@no-llm script_run tool', () => {
  it('runs a registered transformation end-to-end through the wrapper', async () => {
    const services = buildServices();
    const tool = wrapTool(scriptRunSpec(services), services);
    const result = await tool.execute(
      { script_id: 'table_normalize', args: { text: 'a,b\n1,2' } },
      undefined,
    );
    expect(result.status).toBe('ok');
    const payload = JSON.parse(result.modelText) as { output: { headers: string[] } };
    expect(payload.output.headers).toEqual(['a', 'b']);
  });

  it('returns SCRIPT_NOT_FOUND for an unregistered id', async () => {
    const services = buildServices();
    const tool = wrapTool(scriptRunSpec(services), services);
    const result = await tool.execute({ script_id: 'rm -rf /', args: {} }, undefined);
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('SCRIPT_NOT_FOUND');
  });

  it('returns a retryable SCRIPT_INVALID_ARGS for bad arguments', async () => {
    const services = buildServices();
    const tool = wrapTool(scriptRunSpec(services), services);
    const result = await tool.execute(
      { script_id: 'table_normalize', args: { text: 5 } },
      undefined,
    );
    expect(result.error_code).toBe('SCRIPT_INVALID_ARGS');
    expect(result.retryable).toBe(true);
  });

  it('lists the registered scripts in the tool description', () => {
    const services = buildServices();
    const spec = scriptRunSpec(services);
    expect(spec.description).toContain('table_normalize');
  });
});
