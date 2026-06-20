// Backend base URL. Override with VITE_BLOOM_BACKEND_URL at build/dev time.
export const BACKEND_URL: string = (import.meta.env.VITE_BLOOM_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';
