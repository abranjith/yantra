/**
 * Page navigation the app performs itself (FEAT-066), behind one object so
 * tests can observe it (jsdom's `window.location` cannot be spied on).
 */
export const browserNav = {
  /** Loads `url`; an attachment response downloads and leaves the page in place. */
  assign(url: string): void {
    window.location.assign(url);
  },
};
