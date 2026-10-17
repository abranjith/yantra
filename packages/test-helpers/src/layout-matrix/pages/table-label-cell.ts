import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'table-label-cell',
  pattern: 'table-label-cell',
  html: () =>
    '<!doctype html><html><body><table><tr><td>First name</td><td><input data-fixture-key="first"></td><td>Last name</td><td><input data-fixture-key="last"></td></tr></table></body></html>',
  controls: [
    {
      key: 'first',
      role: 'textbox',
      expect: { kind: 'label', query: 'First name', origin: 'structural' },
    },
    {
      key: 'last',
      role: 'textbox',
      expect: { kind: 'label', query: 'Last name', origin: 'structural' },
    },
  ],
};
