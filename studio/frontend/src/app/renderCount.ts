// Test-only instrumentation: counts renders per named component.
declare global {
  interface Window {
    __renderCounts?: Record<string, number>;
  }
}

export function bumpRenderCount(name: string): void {
  if (import.meta.env.PROD) return;
  const w = window as Window;
  w.__renderCounts = w.__renderCounts ?? {};
  w.__renderCounts[name] = (w.__renderCounts[name] ?? 0) + 1;
}
