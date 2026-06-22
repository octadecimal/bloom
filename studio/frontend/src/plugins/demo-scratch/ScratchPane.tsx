import { scratchHooks } from './state';
import { bumpRenderCount } from '../../app/renderCount';

export function ScratchPane() {
  const s = scratchHooks.usePluginState();
  bumpRenderCount('ScratchPane');
  return (
    <div data-testid="scratch-pane" className="h-full bg-surface p-3">
      <input data-testid="scratch-input" value={s.text.get()} onChange={(e) => s.text.set(e.target.value)} />
    </div>
  );
}
