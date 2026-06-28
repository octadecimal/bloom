// A fixed, high-contrast palette indexed by a stable string hash. Pure and
// deterministic so the same symbol always renders the same color (placeholder
// art: real symbol textures are a later slice).
const PALETTE = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4'];

export function colorForSymbol(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
