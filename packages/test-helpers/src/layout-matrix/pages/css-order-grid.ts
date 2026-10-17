import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'css-order-grid',
  pattern: 'css-order-grid',
  html: () =>
    '<!doctype html><html><body><section style="display:flex"><div style="order:2">Family name<input data-fixture-key="family"></div><div style="order:1">Given name<input data-fixture-key="given"></div></section></body></html>',
  controls: [
    {
      key: 'family',
      role: 'textbox',
      expect: { kind: 'label', query: 'Family name', origin: 'structural' },
    },
    {
      key: 'given',
      role: 'textbox',
      expect: { kind: 'label', query: 'Given name', origin: 'structural' },
    },
  ],
};
