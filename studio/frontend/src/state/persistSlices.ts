import type { IPlugin } from '../host/types';

// TODO(Task 13): Wire per-slice debounced persistence.
//
// Hookstate v4 (4.0.2) does not expose a post-creation subscribe/attach API.
// The v3 `.attach(() => ({ id, init, onSet }))` pattern does not exist in v4.
// The v4 Extension mechanism is passed to `hookstate()` at creation time only;
// because `rootStore` is created without an extension there is no hook point
// available after the fact.
//
// Options for Task 13:
//  a) Re-create rootStore with an `onSet` Extension that calls makeDebouncedSaver
//     when the path matches a plugin slice with persist:true.
//  b) Have each persist:true plugin's init() register its own watcher via a
//     thin wrapper that re-exports rootStore with a persistence extension.
//
// For now this function is a deliberate no-op so the rest of Task 9 (dockview
// mount, boot wiring, e2e) can land cleanly.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerSlicePersistence(_plugins: IPlugin[]): void {
  // no-op: see TODO above
}
