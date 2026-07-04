import '@testing-library/jest-dom/vitest';

// Mock window.location for config imports that read backendUrl() at module load time.
Object.defineProperty(global, 'window', {
  value: {
    location: {
      protocol: 'http:',
      hostname: 'localhost',
    },
    matchMedia: (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  },
  writable: true,
});

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
