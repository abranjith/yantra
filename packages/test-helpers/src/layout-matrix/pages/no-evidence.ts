import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'no-evidence',
  pattern: 'no-evidence',
  html: () =>
    '<!doctype html><html><body><p>Unbound text before an unrelated collection</p><section><input data-fixture-key="a"><input data-fixture-key="b"></section></body></html>',
  controls: [
    { key: 'a', role: 'textbox', expect: { kind: 'ref-only' } },
    { key: 'b', role: 'textbox', expect: { kind: 'ref-only' } },
  ],
};
