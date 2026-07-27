// @no-llm
/**
 * `yantra run` output rendering.
 *
 * A successful run used to print only `✓ Run <id>: success`. The data the
 * workflow collected — the entire point of replaying it — was reachable only by
 * opening `outputs.json` or re-running with `--json`, so a run that worked was
 * indistinguishable from one that did nothing.
 */

import { describe, expect, it } from 'vitest';

import { renderOutputs } from '../../src/commands/run.js';

describe('@no-llm renderOutputs', () => {
  it('prints each output under its name', () => {
    const rendered = renderOutputs({
      page_content: 'Delivered Monday, 07/21/2025 at 2:14 P.M.',
    });

    expect(rendered).toContain('page_content:');
    expect(rendered).toContain('Delivered Monday, 07/21/2025 at 2:14 P.M.');
  });

  it('indents multi-line values under their name', () => {
    const rendered = renderOutputs({ status: 'Delivered\nLeft at: Front Door' });

    expect(rendered).toContain('  Delivered');
    expect(rendered).toContain('  Left at: Front Door');
  });

  it('renders structured values as JSON', () => {
    const rendered = renderOutputs({ rows: [{ date: '07/21', event: 'Delivered' }] });

    expect(rendered).toContain('"event": "Delivered"');
  });

  it('renders every declared output, not just the first', () => {
    const rendered = renderOutputs({ first: 'one', second: 'two' });

    expect(rendered).toContain('first:');
    expect(rendered).toContain('second:');
  });

  it('truncates a very long value and points at the full artifact', () => {
    // A page-level extraction can run to tens of kilobytes; flooding the
    // terminal with it helps nobody.
    const rendered = renderOutputs({ page_content: 'x'.repeat(10_000) });

    expect(rendered).toContain('truncated');
    expect(rendered).toContain('outputs.json');
    expect(rendered.length).toBeLessThan(6_000);
  });

  it('explains an empty result instead of printing nothing', () => {
    // This is exactly the state a promoted workflow used to be saved in: no
    // extract step, no outputs. Saying so beats silence.
    const rendered = renderOutputs({});

    expect(rendered).toContain('no outputs');
    expect(rendered).toContain('extract');
  });

  it('renders null and non-string scalars without throwing', () => {
    const rendered = renderOutputs({ missing: null, count: 3, ok: true });

    expect(rendered).toContain('null');
    expect(rendered).toContain('3');
    expect(rendered).toContain('true');
  });
});
