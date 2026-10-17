import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'repeated-sections',
  pattern: 'repeated-sections',
  html: () =>
    '<!doctype html><html><body><form><fieldset><legend>Billing</legend><div>City<input data-fixture-key="billing-city"></div></fieldset><fieldset><legend>Shipping</legend><div>City<input data-fixture-key="shipping-city"></div></fieldset><h2>Office</h2><div>Region<input data-fixture-key="region"></div></form></body></html>',
  controls: [
    {
      key: 'billing-city',
      role: 'textbox',
      expect: { kind: 'label', query: 'Billing City', origin: 'structural' },
    },
    {
      key: 'shipping-city',
      role: 'textbox',
      expect: { kind: 'label', query: 'Shipping City', origin: 'structural' },
    },
    {
      key: 'region',
      role: 'textbox',
      expect: { kind: 'label', query: 'Office Region', origin: 'structural' },
    },
  ],
};
