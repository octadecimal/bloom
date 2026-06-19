import { scratchHooks } from './state';
import { bumpRenderCount } from '../../app/renderCount';

export function ScratchPane() {
  const s = scratchHooks.usePluginState();
  bumpRenderCount('ScratchPane');
  return (
    <div data-testid="scratch-pane" style={{ padding: 12 }}>
      <input data-testid="scratch-input" value={s.text.get()} onChange={(e) => s.text.set(e.target.value)} />
    </div>
  );
}
