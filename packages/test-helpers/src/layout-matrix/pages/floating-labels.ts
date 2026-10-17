import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'floating-labels',
  pattern: 'floating-labels',
  html: () =>
    '<!doctype html><html><body><div><input data-fixture-key="email" placeholder=" "><span>Email</span></div></body></html>',
  controls: [
    {
      key: 'email',
      role: 'textbox',
      expect: { kind: 'label', query: 'Email', origin: 'structural' },
    },
  ],
};
