import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import { installCssEscape } from './support/css-escape.js';
import {
  installIntersectionObserver,
  resetIntersectionObservers,
} from './support/intersection-observer.js';
import { installMatchMedia, resetMatchMedia } from './support/match-media.js';

installMatchMedia();
installCssEscape();
installIntersectionObserver();
// jsdom has no canvas; axe probes it for checks that only run in real Chrome.
HTMLCanvasElement.prototype.getContext = () => null;

afterEach(() => {
  cleanup();
  resetMatchMedia();
  resetIntersectionObservers();
});
