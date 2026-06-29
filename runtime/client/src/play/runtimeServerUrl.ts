export interface ILocationLike {
  hostname: string;
}

/** Resolve the runtime/server base URL. Precedence: an explicit `?server=` query
 *  param wins; otherwise host-derived from the page's own hostname so a LAN
 *  browser reaches the dev host (never a hardcoded localhost). */
export function resolveRuntimeServerUrl(params: URLSearchParams, location: ILocationLike, opts: { defaultPort: number }): string {
  const override = params.get('server');
  if (override) return override.replace(/\/+$/, '');
  return `http://${location.hostname}:${opts.defaultPort}`;
}
