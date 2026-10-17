import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'dynamic-replacement',
  pattern: 'dynamic-replacement',
  html: () =>
    '<!doctype html><html><body><div>Email<input data-fixture-key="email"></div><button type="button" onclick="const old=document.querySelector(\'input\'); old.replaceWith(old.cloneNode());">Replace</button></body></html>',
  controls: [
    {
      key: 'email',
      role: 'textbox',
      expect: { kind: 'label', query: 'Email', origin: 'structural' },
    },
  ],
};
