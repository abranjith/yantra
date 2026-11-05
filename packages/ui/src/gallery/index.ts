/**
 * `@yantra/ui/gallery` — the Drshya gallery (spec D3). FEAT-065 mounts it at
 * `/gallery` in development builds of `apps/web`.
 */

export { Gallery, gallerySearch, parseGallerySearch } from './Gallery.js';
export type { GalleryLocation, GalleryProps } from './Gallery.js';
export { GALLERY_ENTRIES } from './entries.js';
export type { GalleryEntry } from './entries.js';
