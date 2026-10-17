import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'describedby-help',
  pattern: 'describedby-help',
  html: () =>
    '<!doctype html><html><body><div><span>Account code</span><input data-fixture-key="code" aria-describedby="help" aria-errormessage="error"><small id="help">Use eight digits</small><span id="error" role="alert">Invalid code</span></div></body></html>',
  controls: [
    {
      key: 'code',
      role: 'textbox',
      expect: { kind: 'label', query: 'Account code', origin: 'structural' },
    },
  ],
};
