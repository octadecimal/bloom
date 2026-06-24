// Resolve a Texture.src to a URL the iframe can actually fetch. The engine is
// cross-origin (default :4300), so a root-relative /media path must be made
// absolute against the studio backend (passed in via ?mediaBase). Absolute URLs
// pass through; standalone (empty mediaBase) is identity, preserving Plan 1.
export function resolveTextureSrc(src: string, mediaBase: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (mediaBase && src.startsWith('/')) return mediaBase + src;
  return src;
}
