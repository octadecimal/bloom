import { counterHooks } from './state';
import { bumpRenderCount } from '../../app/renderCount';

export function MirrorPane() {
  const s = counterHooks.usePluginState();
  bumpRenderCount('MirrorPane');
  return (
    <div data-testid="mirror-pane" style={{ padding: 12 }}>
      count is {s.count.get()}
    </div>
  );
}
