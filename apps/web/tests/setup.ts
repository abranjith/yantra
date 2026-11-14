import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { installCssEscape } from './support/css-escape.js';
import { installMatchMedia, resetMatchMedia } from './support/match-media.js';

// jsdom ships no CSS.escape or matchMedia; React Aria collections need both.
installCssEscape();
installMatchMedia();
// jsdom has no canvas; axe probes it for icon and contrast checks it cannot run here.
HTMLCanvasElement.prototype.getContext = () => null;

// jsdom does not implement scrolling; the router restores scroll on navigation.
window.scrollTo = () => undefined;

afterEach(() => {
  cleanup();
  resetMatchMedia();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
