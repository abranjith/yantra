import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { installMatchMedia, resetMatchMedia } from './support/match-media.js';

installMatchMedia();

afterEach(() => {
  cleanup();
  resetMatchMedia();
});
