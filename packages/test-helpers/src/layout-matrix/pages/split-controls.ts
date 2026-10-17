import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'split-controls',
  pattern: 'split-controls',
  html: () =>
    '<!doctype html><html><body><div>Phone<input data-fixture-key="area" aria-label="Area"><input data-fixture-key="prefix" aria-label="Prefix"><input data-fixture-key="line" aria-label="Line"></div><div><select data-fixture-key="month"><option value="">Month</option><option>1</option></select><select data-fixture-key="day"><option value="">Day</option><option>1</option></select><select data-fixture-key="year"><option value="">Year</option><option>2026</option></select></div></body></html>',
  controls: [
    { key: 'area', role: 'textbox', expect: { kind: 'label', query: 'Area', origin: 'explicit' } },
    {
      key: 'prefix',
      role: 'textbox',
      expect: { kind: 'label', query: 'Prefix', origin: 'explicit' },
    },
    { key: 'line', role: 'textbox', expect: { kind: 'label', query: 'Line', origin: 'explicit' } },
    {
      key: 'month',
      role: 'combobox',
      expect: { kind: 'label', query: 'Month', origin: 'placeholder' },
    },
    {
      key: 'day',
      role: 'combobox',
      expect: { kind: 'label', query: 'Day', origin: 'placeholder' },
    },
    {
      key: 'year',
      role: 'combobox',
      expect: { kind: 'label', query: 'Year', origin: 'placeholder' },
    },
  ],
};
