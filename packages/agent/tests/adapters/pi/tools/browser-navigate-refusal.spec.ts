import { describe, expect, it } from 'vitest';

import { browserNavigateSpec } from '../../../../src/adapters/pi/tools/browser-navigate.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';

import { buildServices } from './test-support.js';

describe('@no-llm repeated URL provenance refusal guidance', () => {
  it('uses the standard message first and escalates the second normalized refusal', async () => {
    const services = buildServices();
    const tool = wrapTool(browserNavigateSpec(services), services);

    const first = await tool.execute(
      { url: 'https://example.com/Hotel-Search?b=2&a=1' },
      undefined,
    );
    const second = await tool.execute(
      { url: 'https://EXAMPLE.com/Hotel-Search?a=1&b=2#results' },
      undefined,
    );

    expect(first.error_code).toBe('URL_NOT_FROM_EVIDENCE');
    expect(first.modelText).not.toMatch(/repeating this URL/i);
    expect(second.error_code).toBe('URL_NOT_FROM_EVIDENCE');
    expect(second.modelText).toMatch(/submit.*form.*browser_click/i);
    expect(second.modelText).toMatch(/search result/i);
    expect(second.modelText).toMatch(/repeating this URL will keep failing/i);
  });

  it('does not combine refusals for different URLs', async () => {
    const services = buildServices();
    const tool = wrapTool(browserNavigateSpec(services), services);

    const first = await tool.execute({ url: 'https://example.com/one' }, undefined);
    const second = await tool.execute({ url: 'https://example.com/two' }, undefined);

    expect(first.modelText).not.toMatch(/repeating this URL/i);
    expect(second.modelText).not.toMatch(/repeating this URL/i);
  });

  it('keeps refusal history scoped to one RunServices instance', async () => {
    const firstRun = buildServices();
    const firstTool = wrapTool(browserNavigateSpec(firstRun), firstRun);
    await firstTool.execute({ url: 'https://example.com/Hotel-Search' }, undefined);
    await firstTool.execute({ url: 'https://example.com/Hotel-Search' }, undefined);

    const freshRun = buildServices();
    const fresh = await wrapTool(browserNavigateSpec(freshRun), freshRun).execute(
      { url: 'https://example.com/Hotel-Search' },
      undefined,
    );

    expect(fresh.modelText).not.toMatch(/repeating this URL/i);
  });
});
