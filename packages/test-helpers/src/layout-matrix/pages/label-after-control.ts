import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'label-after-control',
  pattern: 'label-after-control',
  html: () =>
    '<!doctype html><html><body><div><input data-fixture-key="phone"><span>Phone number</span></div></body></html>',
  controls: [
    {
      key: 'phone',
      role: 'textbox',
      expect: { kind: 'label', query: 'Phone number', origin: 'structural' },
    },
  ],
};
