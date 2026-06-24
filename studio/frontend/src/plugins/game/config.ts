export { BACKEND_URL } from '../assets/config';

// The engine dev server runs on a configurable port (default 4300). The origin is
// derived from the current host so the iframe works when the studio is browsed
// from another LAN machine — never a hardcoded localhost.
export const ENGINE_PORT: string = (import.meta.env.VITE_BLOOM_ENGINE_PORT as string | undefined) ?? '4300';

export function engineOrigin(): string {
  return `${window.location.protocol}//${window.location.hostname}:${ENGINE_PORT}`;
}

// The studio backend (default :8000) serves /media. The engine iframe is
// cross-origin, so it needs an absolute, host-derived backend origin — never a
// hardcoded localhost (LAN rule), mirroring engineOrigin() above.
export const BACKEND_PORT: string = (import.meta.env.VITE_BLOOM_BACKEND_PORT as string | undefined) ?? '8000';

export function backendOrigin(): string {
  return `${window.location.protocol}//${window.location.hostname}:${BACKEND_PORT}`;
}
