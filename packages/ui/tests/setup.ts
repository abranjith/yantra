import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { installCssEscape } from './support/css-escape.js';
import { installMatchMedia, resetMatchMedia } from './support/match-media.js';

installMatchMedia();
installCssEscape();

afterEach(() => {
  cleanup();
  resetMatchMedia();
});
