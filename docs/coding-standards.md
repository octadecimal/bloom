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

## Rust

_None yet._

## Python

_None yet._
