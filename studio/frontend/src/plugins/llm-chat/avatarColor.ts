// Deterministic avatar hue (0–359) derived from a seed string (e.g. author name).
// This is a data-derived per-participant color, NOT a theme color, so it is exempt
// from the tokens-only rule. The assistant uses the primary token instead of this.
export function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) % 360;
  }
  return h;
}
