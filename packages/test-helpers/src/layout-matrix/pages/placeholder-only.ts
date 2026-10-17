import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'placeholder-only',
  pattern: 'placeholder-only',
  html: () =>
    '<!doctype html><html><body><input data-fixture-key="email" placeholder="Email"><input data-fixture-key="title" title="Town"></body></html>',
  controls: [
    {
      key: 'email',
      role: 'textbox',
      expect: { kind: 'label', query: 'Email', origin: 'placeholder' },
    },
    { key: 'title', role: 'textbox', expect: { kind: 'label', query: 'Town', origin: 'title' } },
  ],
};
