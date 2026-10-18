// @no-llm
/**
 * Protected fields filled with synthetic caller data, in real Chrome.
 *
 * jsdom runs every in-page function in Node, where it can close over anything,
 * so only a real page proves the scan, the committed read, and the comparator
 * are self-contained. It is also the only place a real input mask, a real
 * password field, and the agent controller's own observation meet.
 */
import { describe, expect, it } from 'vitest';

import type { AgentInteractable } from '../../src/browser/agent-controller.js';
import { fillField } from '../../src/fill/engine.js';
import { defaultWidgetBudget, type WidgetTarget } from '../../src/widgets/types.js';
import { layoutBrowser } from '../helpers/layout-browser.js';

const SYNTHETIC = 'YANTRA-protected-synthetic';

const FIXTURE = `
<form>
  <label>Password <input type="password" name="pw"></label>
  <label>New password <input autocomplete="new-password" name="np"></label>
  <label>One-time code <input autocomplete="one-time-code" name="otp"></label>
  <label>Card number <input autocomplete="cc-number" name="cc" id="cc"></label>
  <label>Security code <input autocomplete="cc-csc" name="csc"></label>
  <label>Email <input type="email" autocomplete="email" name="email"></label>
</form>
<script>
  // A card mask: digits only, grouped in fours.
  const cc = document.getElementById('cc');
  cc.addEventListener('input', () => {
    cc.value = cc.value.replace(/\\D/g, '').replace(/(\\d{4})(?=\\d)/g, '$1 ');
  });
</script>`;

/** `[accessible name, value sent, expected success]` per control. */
const CASES: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ['Password', `${SYNTHETIC}-pw`, { withheld: { reason: 'password', verdict: 'exact' } }],
  ['New password', `${SYNTHETIC}-np`, { withheld: { reason: 'autocomplete', verdict: 'exact' } }],
  ['One-time code', '123456', { withheld: { reason: 'autocomplete', verdict: 'exact' } }],
  [
    'Card number',
    '4111111111111111',
    { withheld: { reason: 'autocomplete', verdict: 'reformatted' } },
  ],
  ['Security code', '123', { withheld: { reason: 'autocomplete', verdict: 'exact' } }],
  ['Email', 'ada@example.test', { committed: 'ada@example.test', resolution: 'exact' }],
];

function toTarget(entry: AgentInteractable): WidgetTarget {
  return { ref: entry.ref, role: entry.role, name: entry.name, group: null, value: null };
}

describe('@no-llm protected-field fill in real Chrome', () => {
  it('verifies every protected field in page and discloses none of their values', async () => {
    const browser = await layoutBrowser();
    try {
      await browser.page.setContent(FIXTURE);
      const before = await browser.controller.observe();
      const results: Record<string, unknown>[] = [];

      for (const [name, value, expected] of CASES) {
        const entry = before.interactables.find((candidate) => candidate.name === name);
        if (!entry) throw new Error(`The fixture has no control named "${name}".`);
        const outcome = await fillField(
          browser.controller,
          { field: name, target: toTarget(entry!), observation: before },
          { kind: 'text', text: value },
          defaultWidgetBudget(browser.controller),
        );
        expect({ name, outcome }).toMatchObject({ name, outcome: { ok: true, ...expected } });
        if ('withheld' in expected) {
          expect(outcome).not.toHaveProperty('committed');
          // Short codes could collide with ledger timings; long values cannot.
          if (value.length >= 6) expect(JSON.stringify(outcome)).not.toContain(value);
          // The observation and the fill result name the same reason, because
          // both come from the one classifier.
          expect(entry!.withheld).toBe((expected.withheld as { readonly reason: string }).reason);
        }
        results.push(outcome as unknown as Record<string, unknown>);
      }

      const after = await browser.controller.observe();
      for (const [name, value, expected] of CASES) {
        const entry = after.interactables.find((candidate) => candidate.name === name)!;
        if ('withheld' in expected) {
          expect({ name, entry }).toMatchObject({
            name,
            entry: { value_present: true, withheld: expect.any(String) },
          });
          expect(entry).not.toHaveProperty('value');
        } else {
          expect(entry.value).toBe(value);
          expect(entry).not.toHaveProperty('withheld');
        }
      }
      const serialized = JSON.stringify({ results, before, after });
      expect(serialized).not.toContain(SYNTHETIC);
      expect(serialized).not.toContain('4111');
      expect(serialized).not.toContain('123456');
    } finally {
      await browser.close();
    }
  }, 120_000);
});
