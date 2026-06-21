# Coding standards

Durable, repo-wide coding standards. Agents and contributors **MUST** follow these.
New standards are added here as they are agreed. See `AGENTS.md` for how rules bind
agents and for the commit/branch/PR workflow used to land changes here.

## TypeScript

- **Interfaces ALWAYS use an `I` prefix** — e.g. `IPlugin`, `IPaneDef`, `IPluginHost`.
  - Applies to `interface` declarations only.
  - Type aliases (`type Foo = …`) and generic type parameters (`TState`, `T`, …) are
    **not** affected by this rule.
  - External / third-party types keep their original names (e.g. dockview's
    `DockviewPanelProps`, hookstate's `State<T>`). The rule governs interfaces we define.

## Hookstate

- **Read state fields whose names collide with Hookstate's reserved members via
  `.nested('<key>').get()`, not direct property access.** Hookstate v4 reserves
  method/property names on the state proxy — notably **`error`** (returns the proxy's
  built-in async promise-error), plus `value`, `keys`, `get`, `set`, `merge`, etc.
  Reading such a field directly (e.g. `assetNode.error.get()`) silently returns the
  built-in, NOT your data — usually `undefined`, which then throws on `.get()`.
  - Correct: `assetNode.nested('error').get()`. Wrong: `assetNode.error.get()`.
  - This bites any plugin state that has an `error` (or other reserved-name) field. It
    is easy to miss because it only manifests when that field is actually populated.

## Rust

_None yet._

## Python

_None yet._
