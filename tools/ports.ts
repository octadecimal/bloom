import path from 'node:path';
import { loadEnv } from 'vite';

/** Base ports per dev-stack service. Offset 0 = today's defaults. */
const BASE = { backend: 8000, frontend: 4200, runtime: 4300 } as const;

/** Repo root, relative to this file (`tools/ports.ts` -> `..`). */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export interface IResolvedPorts {
  /** The worktree's port offset (0 in the primary checkout). */
  offset: number;
  /** Studio backend (uvicorn) port. */
  backend: number;
  /** Studio frontend (Vite) dev-server port. */
  frontend: number;
  /** Runtime client (Vite) dev-server port. */
  runtime: number;
  /** Backend base URL the browser/e2e talk to (proxy target / health check). */
  backendUrl: string;
}

/** Parse a positive-integer port, or undefined for blank/invalid. */
function port(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parse a non-negative-integer offset; blank/invalid -> 0. */
function offsetOf(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Resolve every dev-stack port from a single BLOOM_PORT_OFFSET, with explicit
 * per-service overrides taking precedence. Pure — pass the env map in.
 */
export function resolvePorts(env: Record<string, string | undefined>): IResolvedPorts {
  const offset = offsetOf(env.BLOOM_PORT_OFFSET);
  const backend = port(env.VITE_BLOOM_BACKEND_PORT) ?? BASE.backend + offset;
  const frontend = port(env.BLOOM_FRONTEND_PORT) ?? port(env.VITE_FRONTEND_PORT) ?? BASE.frontend + offset;
  const runtime = port(env.BLOOM_RUNTIME_PORT) ?? BASE.runtime + offset;
  const url = env.VITE_BLOOM_BACKEND_URL;
  const backendUrl = url && url.trim() !== '' ? url : `http://localhost:${backend}`;
  return { offset, backend, frontend, runtime, backendUrl };
}

/** Repo-root `.env` (all keys) with `process.env` overlaid on top (explicit wins). */
export function readRepoEnv(): Record<string, string | undefined> {
  return { ...loadEnv('development', REPO_ROOT, ''), ...process.env };
}
