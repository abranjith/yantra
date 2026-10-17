import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'stacked-wrappers',
  pattern: 'stacked-wrappers',
  html: () =>
    '<!doctype html><html><body><div><span>Email</span><input data-fixture-key="email"></div><div><span>City</span><input data-fixture-key="city"></div></body></html>',
  controls: [
    {
      key: 'email',
      role: 'textbox',
      expect: { kind: 'label', query: 'Email', origin: 'structural' },
    },
    {
      key: 'city',
      role: 'textbox',
      expect: { kind: 'label', query: 'City', origin: 'structural' },
    },
  ],
};
