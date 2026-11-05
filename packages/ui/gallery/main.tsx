import './gallery.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { applyAppearance } from '../src/appearance.js';
import { Gallery, parseGallerySearch } from '../src/gallery/index.js';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Drshya gallery: #root is missing from index.html');
}

// The page itself follows the requested appearance too, so the area around
// the gallery wrapper (and native scrollbars) matches it.
applyAppearance(document.documentElement, parseGallerySearch(location.search).appearance);

createRoot(container).render(
  <StrictMode>
    <Gallery search={location.search} />
  </StrictMode>,
);
