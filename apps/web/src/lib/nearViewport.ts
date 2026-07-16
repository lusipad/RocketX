export interface NearViewportObserver {
  observe: (node: Element) => void;
  unobserve: (node: Element) => void;
  disconnect: () => void;
}

export type NearViewportObserverFactory = (
  callback: (entries: readonly { isIntersecting: boolean; target: Element }[]) => void,
  options: { rootMargin: string },
) => NearViewportObserver | null;

const createBrowserObserver: NearViewportObserverFactory = (callback, options) => {
  if (typeof IntersectionObserver === 'undefined') return null;
  return new IntersectionObserver(callback, options);
};

export class NearViewportRegistry {
  private observer: NearViewportObserver | null = null;
  private readonly callbacks = new Map<Element, () => void>();

  constructor(private readonly createObserver: NearViewportObserverFactory = createBrowserObserver) {}

  observe(node: Element, onVisible: () => void): () => void {
    if (!this.observer) {
      this.observer = this.createObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const target = entry.target;
            const callback = this.callbacks.get(target);
            if (!callback) continue;
            this.callbacks.delete(target);
            this.observer?.unobserve(target);
            callback();
          }
          this.disconnectWhenEmpty();
        },
        { rootMargin: '200px' },
      );
    }
    if (!this.observer) {
      onVisible();
      return () => undefined;
    }
    this.callbacks.set(node, onVisible);
    this.observer.observe(node);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!this.callbacks.delete(node)) return;
      this.observer?.unobserve(node);
      this.disconnectWhenEmpty();
    };
  }

  private disconnectWhenEmpty(): void {
    if (this.callbacks.size > 0 || !this.observer) return;
    this.observer.disconnect();
    this.observer = null;
  }
}

const sharedNearViewport = new NearViewportRegistry();

export function observeNearViewport(node: Element, onVisible: () => void): () => void {
  return sharedNearViewport.observe(node, onVisible);
}
