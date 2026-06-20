// studio/frontend/src/plugins/assets/config.ts
export const BACKEND_URL: string =
  (import.meta.env.VITE_BLOOM_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';
