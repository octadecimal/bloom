import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement matchMedia. uPlot (math-analytics charts) calls it at
// *module load time* (not just on instantiation), so any test that imports the
// uPlot-backed adapter needs this polyfill even if it never mounts a real chart.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom doesn't implement ResizeObserver or Element.scrollIntoView. cmdk
// (CommandPalette's underlying list component) calls both on mount/selection,
// so any test that renders it needs these polyfills even though it never
// asserts on resize/scroll behavior.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
