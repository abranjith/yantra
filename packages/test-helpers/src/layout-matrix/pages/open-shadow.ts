import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'open-shadow',
  pattern: 'open-shadow',
  html: () =>
    '<!doctype html><html><body><div id="host"></div><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML=\'<div>Postal code<input data-fixture-key="postal"></div>\';</script></body></html>',
  controls: [
    {
      key: 'postal',
      role: 'textbox',
      expect: { kind: 'label', query: 'Postal code', origin: 'structural' },
    },
  ],
};
