import type { MatrixPage } from '../types.js';

export const page: MatrixPage = {
  id: 'fieldset-groups',
  pattern: 'fieldset-groups',
  html: () =>
    '<!doctype html><html><body><fieldset><legend>Contact method</legend><input type="radio" name="method" data-fixture-key="email"><input type="radio" name="method" data-fixture-key="phone"></fieldset><fieldset><legend>Interests</legend><input type="checkbox" data-fixture-key="music"><input type="checkbox" data-fixture-key="art"></fieldset></body></html>',
  controls: [
    {
      key: 'email',
      role: 'radio',
      expect: { kind: 'ambiguous', query: 'Contact method', with: ['email', 'phone'] },
    },
    {
      key: 'phone',
      role: 'radio',
      expect: { kind: 'ambiguous', query: 'Contact method', with: ['email', 'phone'] },
    },
    {
      key: 'music',
      role: 'checkbox',
      expect: { kind: 'ambiguous', query: 'Interests', with: ['music', 'art'] },
    },
    {
      key: 'art',
      role: 'checkbox',
      expect: { kind: 'ambiguous', query: 'Interests', with: ['music', 'art'] },
    },
  ],
};
