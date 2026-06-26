// studio/frontend/src/plugins/assets/config.ts

// The studio backend (default :8000) serves /media and the chat/scene socket. Browsing
// from another LAN machine means the backend must be reached at that same host — never a
// hardcoded localhost, which points at the viewer's own machine (mirrors game/config
// backendOrigin(), and the LAN rule the engine iframe already follows).
const BACKEND_PORT = '8000';

export function backendUrl(
  loc: Pick<Location, 'protocol' | 'hostname'> = window.location,
  env = import.meta.env.VITE_BLOOM_BACKEND_URL as string | undefined,
): string {
  return env ?? `${loc.protocol}//${loc.hostname}:${BACKEND_PORT}`;
}

export const BACKEND_URL: string = backendUrl();
