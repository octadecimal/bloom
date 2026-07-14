import { getLayoutPresets } from '../state/layoutPresetsRef';

const PHASES = ['Design', 'Art', 'Math', 'Play'] as const;

// Deliberately stateless: no active-phase highlight — the layout drifts the
// moment the user rearranges panes, and a lying highlight is worse than none.
export function PhaseSwitcher() {
  const presets = getLayoutPresets();
  return (
    <div data-testid="phase-switcher" className="flex items-center overflow-hidden rounded-md border border-border">
      {PHASES.map((name, i) => (
        <button
          key={name}
          type="button"
          data-testid={`phase-${name}`}
          onClick={() => presets.apply(name)}
          className={`px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-raised-hover hover:text-foreground ${i > 0 ? 'border-l border-border' : ''}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
