/**
 * A controllable IntersectionObserver for jsdom (which has none). Tests decide
 * when an observed element intersects; React Aria's load-more sentinel reacts
 * exactly as it would to a real observer.
 */

interface FakeObserver {
  readonly callback: IntersectionObserverCallback;
  readonly targets: Set<Element>;
  readonly observer: IntersectionObserver;
}

const observers = new Set<FakeObserver>();

class FakeIntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  private readonly entry: FakeObserver;

  constructor(callback: IntersectionObserverCallback) {
    this.entry = {
      callback,
      targets: new Set(),
      observer: this as unknown as IntersectionObserver,
    };
    observers.add(this.entry);
  }

  observe(target: Element): void {
    this.entry.targets.add(target);
  }

  unobserve(target: Element): void {
    this.entry.targets.delete(target);
  }

  disconnect(): void {
    this.entry.targets.clear();
    observers.delete(this.entry);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

export function installIntersectionObserver(): void {
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: FakeIntersectionObserver,
  });
}

/** Reports every observed element as intersecting (or not) to its observer. */
export function setIntersecting(isIntersecting: boolean): void {
  for (const { callback, targets, observer } of [...observers]) {
    const entries = [...targets].map(
      (target) => ({ isIntersecting, target }) as unknown as IntersectionObserverEntry,
    );
    if (entries.length > 0) {
      callback(entries, observer);
    }
  }
}

/** How many elements are observed right now. */
export function observedCount(): number {
  return [...observers].reduce((total, { targets }) => total + targets.size, 0);
}

export function resetIntersectionObservers(): void {
  observers.clear();
}
